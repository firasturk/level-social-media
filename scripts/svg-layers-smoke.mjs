/**
 * A browser check of vector layers in the Text studio ("Split into layers", "Remove background",
 * "Merge back", "Add as separate layers"), in headless Chromium against the built app
 * (dist/client) with its API answered by a stateful mock in this file: one month, one post whose
 * design holds three real SVGs from tests/fixtures/svg (a badge, an icon set, an illustration).
 * The mock stores pieces the way the Worker does (sanitised with shared/svg-sanitize.ts, one copy
 * per identical piece) and serves the client's review link from the saved design.
 *
 * The flow, at 1440 × 1000:
 *   1. split the badge: the canvas before and after is compared pixel by pixel (the numbers are
 *      printed); the same for the icon set;
 *   2. the illustration's background: highlighted, removed (the sky's pixel becomes the photo),
 *      undone and redone; then split;
 *   3. one badge piece moved, another recoloured (only that piece changes), one deleted; the
 *      badge's background piece removed (highlight, confirm);
 *   4. saved, the page reloaded, the Text studio reopened: the same layers and the same pixels;
 *      "Save & return"; reopened again: "Merge back" (pixels compared again);
 *   5. the Assets tab: "Add as separate layers" on an SVG vector (split on arrival) and on an
 *      EPS-only one (one picture, and the reason said);
 *   6. the client's review link draws the pieces through /api/share/<token>/layer/<post>/<id>;
 * then at 390 × 844: the vector actions and their labels on screen, no sideways scroll.
 *
 * Usage:  npm run build && node --experimental-strip-types scripts/svg-layers-smoke.mjs [--out dir]
 */
import { createServer } from "node:http";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { pathToFileURL } from "node:url";
import { deflateSync } from "node:zlib";

const root = process.cwd();
const { sanitizeSvg } = await import(pathToFileURL(join(root, "shared", "svg-sanitize.ts")).href);
const { extractSvgColors } = await import(
  pathToFileURL(join(root, "shared", "svg-colors.ts")).href
);

async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch {
    const g = execSync("npm root -g", { encoding: "utf8" }).trim();
    return import(pathToFileURL(join(g, "playwright", "index.mjs")).href);
  }
}
const { chromium } = await loadPlaywright();

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const outDir = opt("--out", join(root, "test-results", "svg-layers"));
await mkdir(outDir, { recursive: true });
const executablePath = process.env.PW_CHROMIUM || "/opt/pw-browsers/chromium";
const dist = join(root, "dist", "client");

function png(w, h, rgb, band) {
  const table = new Uint32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (bytes) => {
    let c = 0xffffffff;
    for (const b of bytes) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const out = new Uint8Array(12 + data.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, data.length);
    out.set(
      [...type].map((ch) => ch.charCodeAt(0)),
      4,
    );
    out.set(data, 8);
    dv.setUint32(8 + data.length, crc(out.subarray(4, 8 + data.length)));
    return out;
  };
  const ihdr = new Uint8Array(13);
  const iv = new DataView(ihdr.buffer);
  iv.setUint32(0, w);
  iv.setUint32(4, h);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const raw = new Uint8Array(h * (1 + w * 3));
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      raw.set(y > h * 0.45 && y < h * 0.55 ? band : rgb, y * (1 + w * 3) + 1 + x * 3);
  const idat = new Uint8Array(deflateSync(raw));
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", new Uint8Array()),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return Buffer.from(out);
}
const PHOTO_RGB = [214, 206, 196];
const BAND_RGB = [190, 180, 170];
const PICTURE = png(1080, 1350, PHOTO_RGB, BAND_RGB);
const isPhoto = (px) => near(px, PHOTO_RGB, 12) || near(px, BAND_RGB, 12);
const EPS_PREVIEW = png(300, 300, [226, 51, 107], [200, 40, 90]);

const fixture = async (name) =>
  sanitizeSvg(await readFile(join(root, "tests", "fixtures", "svg", name), "utf8"));
const FILES = {
  "av-badge": await fixture("badge.svg"),
  "av-icons": await fixture("icon-set.svg"),
  "av-scene": await fixture("illustration.svg"),
  "av-badge2": await fixture("badge.svg"),
};

const NOW = Date.now();
const TOKEN = "e".repeat(32);
const ADMIN = { id: "u1", email: "smoke@example.test", name: "Smoke", role: "admin" };
const CLIENT = {
  id: "c1",
  slug: "habibah",
  name: "Habibah",
  logo: false,
  badge: false,
  colors: [
    { name: "Pistachio", hex: "#8fbf6a" },
    { name: "Royal", hex: "#1129d3" },
  ],
  fonts: {},
  tone: "",
  dos: "",
  donts: "",
  style: "",
  gridRhythm: "",
  language: "en",
  status: "active",
  position: 0,
  batches: 1,
  updated: NOW,
  overlay: null,
  fontFiles: [],
  places: [],
};
const SOURCE = {
  id: "s1",
  name: "pistachio.jpg",
  mime: "image/jpeg",
  size: 1000,
  role: "lead",
  kind: "product",
  created: NOW,
};
const QA = JSON.stringify({
  automated: true,
  flags: [],
  notes: "Looks right.",
  found: true,
  count: 1,
  box: [],
  productConcern: false,
  centered: true,
});
const ACCESS = { admin: true, enabled: true, reason: "" };
const W = 1080;
const H = 1350;
const vectorLayer = (id, asset, name, x, y, w, aspect) => ({
  id,
  type: "image",
  name,
  src: `/api/studio/freepik/assets/${asset}/file?layer=1`,
  x,
  y,
  w,
  h: Math.round(((w * W) / H / aspect) * 1000) / 1000,
  fit: "contain",
  source: "freepik",
  asset,
  format: "SVG",
  note: "Vector bundle with an SVG: the SVG is placed as an editable vector; the EPS/AI files stay in the library.",
  colors: extractSvgColors(FILES[asset]).slice(0, 24),
});
const DESIGN = {
  version: 1,
  layers: [
    vectorLayer("L-scene", "av-scene", "Park illustration", 0.06, 0.45, 0.88, 800 / 600),
    vectorLayer("L-badge", "av-badge", "Sale badge", 0.04, 0.04, 0.44, 1),
    vectorLayer("L-icons", "av-icons", "Shop icons", 0.5, 0.06, 0.46, 600 / 400),
  ],
};

const state = {
  plan: [
    {
      index: 1,
      type: "offer",
      title: "Pistachio week",
      brief: "",
      caption: "",
      hashtags: "",
      product: "pistachio",
      headline: "",
      subline: "",
      ideaAt: 1,
      ov: { design: DESIGN },
    },
  ],
  graphics: new Map(),
  pieceCalls: [],
  planSaves: 0,
  shareLayer: [],
  paid: [],
  downloads: [],
  uses: [],
};
const config = () => ({
  mode: "post",
  input: "model",
  prompt: "",
  ratio: "4:5",
  size: "1K",
  count: 1,
  backdrop: "",
  market: "auto",
  skill: "editorial",
  economy: false,
  output: "jpg",
  outputQuality: 90,
  outputSize: "fit",
  colors: "",
  modelDescription: "",
  center: true,
  client: "c1",
  month: "2026-10",
  postCount: 1,
  format: "4:5",
  model: "nano-banana-pro",
  plan: state.plan,
  plannedAt: 1,
});
const batch = () => ({
  id: "b1",
  name: "Habibah · October 2026",
  config: JSON.stringify(config()),
  client: "c1",
  month: "2026-10",
  theme: null,
  state: "idle",
  last_error: null,
  created: NOW,
  updated: NOW,
});
const TASK = {
  id: "t1",
  source: "s1",
  card: 1,
  status: "ready",
  output: "u1/b1/output/t1/a.png",
  qa: QA,
  error: null,
  prompt: "",
  attempts: 1,
  request_id: null,
  brief: null,
  cost: 0.04,
  updated: NOW,
  post: 1,
  made_for: 1,
};

/** The Freepik catalogue for "Add as separate layers": an SVG vector and an EPS-only one. */
const lic = {
  type: "freemium",
  attribution: true,
  uses: [],
  url: "https://www.freepik.com/legal/terms-of-use",
};
const ITEMS = [
  {
    id: "801",
    kind: "vector",
    title: "Sale badge set",
    author: "Vectorist",
    license: lic,
    preview: "/fp/preview/801.svg",
    width: 800,
    height: 800,
    orientation: "square",
    flattened: false,
    formats: ["svg", "eps"],
    url: "",
    demo: false,
  },
  {
    id: "802",
    kind: "vector",
    title: "Brush lettering, SALE",
    author: "Vectorist",
    license: lic,
    preview: "/fp/preview/802.png",
    width: 800,
    height: 800,
    orientation: "square",
    flattened: false,
    formats: ["eps"],
    url: "",
    demo: false,
  },
];
const assetOf = (it, stored) => ({
  id: `a${it.id}`,
  client: "c1",
  providerId: it.id,
  kind: it.kind,
  title: it.title,
  author: it.author,
  license: it.license,
  preview: it.preview,
  file: stored ? `/api/studio/freepik/assets/a${it.id}/file` : null,
  stored,
  mime: "application/zip",
  width: it.width,
  height: it.height,
  flattened: false,
  layerable: true,
  format: it.id === "801" ? "SVG" : "EPS/AI",
  contents: it.id === "801" ? ["eps", "svg"] : ["eps"],
  editable: it.id === "801",
  colors: it.id === "801" ? extractSvgColors(FILES["av-badge2"]) : [],
  formatNote:
    it.id === "801"
      ? "Vector bundle with an SVG"
      : "This file is EPS/AI: colours cannot be changed here. The preview picture is placed instead.",
  layerSrc:
    it.id === "801" ? "/api/studio/freepik/assets/av-badge2/file?layer=1" : "/fp/preview/802.png",
  lettering: it.id === "802",
  demo: false,
});
const layerOf = (it) =>
  it.id === "801"
    ? {
        src: "/api/studio/freepik/assets/av-badge2/file?layer=1",
        name: it.title,
        flattened: false,
        layerable: true,
        preview: false,
        format: "SVG",
        editable: true,
        colors: extractSvgColors(FILES["av-badge2"]),
        note: "Vector bundle with an SVG",
        lettering: false,
        kind: "vector",
        aspect: 1,
      }
    : {
        src: "/fp/preview/802.png",
        name: it.title,
        flattened: true,
        layerable: true,
        preview: true,
        format: "EPS/AI",
        editable: false,
        colors: [],
        note: "This file is EPS/AI: colours cannot be changed here. The preview picture is placed instead.",
        lettering: true,
        kind: "vector",
        aspect: 1,
      };
const stored = new Set();

function api(path, u) {
  const fixed = {
    "/api/auth/me": { user: ADMIN, registrationOpen: false },
    "/api/studio/state": {
      user: ADMIN,
      batches: [batch()],
      trash: [],
      spend: [],
      spendThreshold: 20,
      clients: [CLIENT],
      engine: {
        model: "nano-banana-pro",
        configured: false,
        source: "none",
        openai: "none",
        google: "none",
        fal: "none",
        review: false,
        vertex: null,
      },
      preview: true,
      workflowV2: true,
    },
    "/api/studio/batch": { batch: batch(), sources: [SOURCE], tasks: [TASK] },
    "/api/studio/engine/models": { models: [] },
    "/api/studio/styles/pending": { n: 0 },
    "/api/studio/lessons/pending": { n: 0 },
    "/api/studio/posts/themes": { themes: [] },
    "/api/studio/posts/takes": {
      takes: [
        {
          id: "tk1",
          index: 1,
          status: "made",
          key: TASK.output,
          image: "/api/studio/file?batch=b1&id=t1&kind=result&v=a.png",
          cost: 0.04,
          note: "first take",
          madeFor: 1,
          created: NOW - 60000,
          current: true,
        },
      ],
    },
    "/api/studio/posts/versions": { versions: [] },
    "/api/studio/posts/video/summary": { posts: {} },
    "/api/studio/posts/video/list": {
      videos: [],
      engines: [],
      prices: {},
      admin: true,
      access: ACCESS,
      billing: "credits",
    },
    "/api/studio/photolab/status": {
      connected: false,
      provider: "demo",
      reason: "No key",
      prices: {},
      approximate: true,
      access: ACCESS,
    },
    "/api/studio/photolab/jobs": { jobs: [] },
    "/api/studio/freepik/status": {
      connected: true,
      demo: false,
      reason: "",
      admin: true,
      access: "admin",
      plan: "premium",
      planLabel: "",
      downloadEstimate: 0,
      entitlements: {},
      mcp: { connected: false, url: "" },
      switch: { enabled: true, reason: "" },
    },
    "/api/studio/freepik/assets": { assets: [] },
    "/api/studio/drive/c1": {
      groups: { product: [], reference: [] },
      photos: [],
      missing: [],
      demo: true,
    },
    "/api/studio/ambassadors": { ambassadors: [] },
    "/api/studio/publish/status": { connected: false },
    "/api/studio/publish": { publications: [] },
    "/api/studio/ocr/status": { connected: false, provider: "none", reason: "Not connected" },
    "/api/studio/photo/tools/catalog": {
      ok: true,
      admin: true,
      tools: [],
      higgsfield: {
        provider: "higgsfield",
        connected: false,
        enabled: true,
        admin: true,
        reason: "",
        balance: null,
        available: {},
      },
      magnific: {
        provider: "magnific",
        connected: false,
        enabled: true,
        admin: true,
        reason: "",
        balance: null,
        available: {},
      },
      upscalePresets: [],
      upscaleModes: [],
      retouchModels: [],
      cachedAt: NOW,
    },
    "/api/studio/photo/tools/jobs": { ok: true, jobs: [] },
    "/api/studio/photo/presets": {
      ok: true,
      category: "styles",
      categories: [],
      provider: "higgsfield",
      items: [],
      cachedAt: NOW,
      cached: true,
      signedIn: false,
      admin: true,
      access: ACCESS,
      reason: "",
      empty: "",
    },
  };
  void u;
  return fixed[path];
}

/** The Worker's shareDesign: studio-addressed image layers through the review link. */
const shareDesign = (design, index) => ({
  ...design,
  layers: design.layers.map((l) =>
    l.type === "image" && l.src.startsWith("/api/studio/")
      ? { ...l, src: `/api/share/${TOKEN}/layer/${index}/${encodeURIComponent(l.id)}` }
      : l,
  ),
});
/** The bytes behind a studio address (the mock's layerFile). */
function fileOf(src) {
  const u = new URL(src, "http://x");
  let m = /^\/api\/studio\/freepik\/assets\/([^/]+)\/file$/.exec(u.pathname);
  if (m && FILES[m[1]]) return { body: FILES[m[1]], type: "image/svg+xml" };
  if (u.pathname === "/api/studio/posts/graphic" && u.searchParams.get("batch") === "b1") {
    const svg = state.graphics.get(u.searchParams.get("id") ?? "");
    return svg ? { body: svg, type: "image/svg+xml" } : null;
  }
  return null;
}

const PAID = [
  /\/posts\/revise/,
  /\/posts\/generate/,
  /\/photolab\/run/,
  /\/photo\/tools\/run/,
  /\/engine\/(run|generate)/,
  /\/posts\/remake/,
  /\/higgsfield\/.*(run|generate)/,
  /\/video\/.*(render|generate)/,
];
const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".woff2": "font/woff2",
  ".json": "application/json",
  ".ico": "image/x-icon",
};
const readBody = (req) =>
  new Promise((ok) => {
    const parts = [];
    req.on("data", (c) => parts.push(c));
    req.on("end", () => ok(Buffer.concat(parts).toString()));
  });

async function startStatic() {
  const server = createServer(async (req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    const path = decodeURIComponent(u.pathname);
    const send = (body, status = 200, type = "application/json") => {
      res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
      res.end(type === "application/json" ? JSON.stringify(body) : body);
    };
    if (PAID.some((r) => r.test(path))) state.paid.push(path);
    if (path === "/api/studio/file") return send(PICTURE, 200, "image/png");
    if (path === "/fp/preview/801.svg") return send(FILES["av-badge2"], 200, "image/svg+xml");
    if (path === "/fp/preview/802.png") return send(EPS_PREVIEW, 200, "image/png");
    if (path.startsWith("/api/studio/freepik/assets/") || path === "/api/studio/posts/graphic") {
      if (req.method === "GET") {
        const f = fileOf(req.url);
        return f ? send(f.body, 200, f.type) : send({ error: "No such graphic." }, 404);
      }
    }
    if (path === "/api/studio/posts/graphic/pieces" && req.method === "POST") {
      // As the Worker does it: every piece sanitised, stored once per identical content.
      const body = JSON.parse((await readBody(req)) || "{}");
      const urls = [];
      let fresh = 0;
      for (const text of body.pieces ?? []) {
        const clean = sanitizeSvg(text);
        const id = createHash("sha256").update(clean).digest("hex").slice(0, 32);
        if (!state.graphics.has(id)) fresh++;
        state.graphics.set(id, clean);
        urls.push(`/api/studio/posts/graphic?batch=b1&id=${id}`);
      }
      state.pieceCalls.push({
        count: urls.length,
        fresh,
        bytes: (body.pieces ?? []).reduce((n, s) => n + s.length, 0),
      });
      return send({ ok: true, urls, stored: fresh, reused: urls.length - fresh });
    }
    if (path === "/api/studio/posts/plan" && req.method === "PUT") {
      const body = JSON.parse((await readBody(req)) || "{}");
      if (body.plan) state.plan = body.plan;
      state.planSaves++;
      return send({ ok: true, plan: state.plan });
    }
    if (path === "/api/studio/freepik/search")
      return send({
        items: ITEMS,
        page: 1,
        lastPage: 1,
        total: ITEMS.length,
        demo: false,
        connected: true,
        downloadEstimate: 0,
      });
    if (path === "/api/studio/freepik/download") {
      const b = JSON.parse((await readBody(req)) || "{}");
      state.downloads.push(b.id);
      const it = ITEMS.find((x) => x.id === b.id);
      if (!b.confirm && !stored.has(b.id))
        return send(
          {
            error: "Confirm the download.",
            needsConfirm: true,
            estimate: 0,
            asset: assetOf(it, false),
          },
          409,
        );
      stored.add(b.id);
      return send({ ok: true, asset: assetOf(it, true), reused: false, estimate: 0 });
    }
    if (path === "/api/studio/freepik/use") {
      const b = JSON.parse((await readBody(req)) || "{}");
      state.uses.push(b);
      const it = ITEMS.find((x) => `a${x.id}` === b.asset);
      return send({
        ok: true,
        asset: assetOf(it, true),
        use: {
          id: "u",
          role: b.role,
          batch: "b1",
          post: 1,
          slide: null,
          layerId: b.layerId ?? null,
        },
        layer: layerOf(it),
      });
    }
    // The client's review link, from the saved design.
    if (path === `/api/share/${TOKEN}`) {
      const p = state.plan[0];
      return send({
        client: {
          name: "Habibah",
          instagram: null,
          overlay: null,
          logo: false,
          badge: false,
          fonts: [],
          updated: NOW,
        },
        month: "2026-10",
        grid: false,
        order: [1],
        monthFonts: null,
        posts: [
          {
            video: null,
            version: { kind: "image", id: String(NOW), label: "Picture" },
            index: 1,
            date: null,
            headline: p.headline ?? "",
            subline: p.subline ?? "",
            overlay: true,
            ov: p.ov ? { ...p.ov, design: shareDesign(p.ov.design, 1) } : null,
            caption: "",
            hashtags: "",
            faces: [],
            group: null,
            image: NOW,
            approval: null,
          },
        ],
      });
    }
    const layerM = new RegExp(`^/api/share/${TOKEN}/layer/(\\d+)/(.+)$`).exec(path);
    if (layerM) {
      const post = state.plan.find((p) => p.index === Number(layerM[1]));
      const layer = post?.ov?.design?.layers?.find((l) => l.id === layerM[2] && l.type === "image");
      const f = layer ? fileOf(layer.src) : null;
      state.shareLayer.push({ id: layerM[2], status: f ? 200 : 404 });
      return f ? send(f.body, 200, f.type) : send({ error: "Layer not found." }, 404);
    }
    if (path.startsWith(`/api/share/${TOKEN}/image/`)) return send(PICTURE, 200, "image/png");
    if (path.startsWith("/api/")) {
      const body = api(path, u) ?? (path.includes("/list") || path.endsWith("s") ? [] : {});
      return send(body);
    }
    let file = normalize(join(dist, path));
    if (!file.startsWith(dist)) file = join(dist, "index.html");
    try {
      const s = await stat(file);
      if (s.isDirectory()) file = join(file, "index.html");
      await stat(file);
    } catch {
      file = join(dist, "index.html");
    }
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    res.end(await readFile(file));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

const served = await startStatic();
const url = served.url;
const browser = await chromium.launch({ executablePath, headless: true });
const errors = [];
const outside = [];
const ALLOWED = [
  url,
  "data:",
  "blob:",
  "https://fonts.googleapis.com/",
  "https://fonts.gstatic.com/",
];
const result = {};

async function newPage(viewport) {
  const page = await browser.newPage({ viewport });
  page.on("pageerror", (e) => errors.push(`page error: ${String(e)}`));
  page.on(
    "console",
    (m) =>
      m.type() === "error" &&
      !/favicon|404|409|Failed to load resource|Failed to fetch/.test(m.text()) &&
      errors.push(`console error: ${m.text()}`),
  );
  page.on("request", (r) => {
    const u = r.url();
    if (!ALLOWED.some((a) => u.startsWith(a))) outside.push(u);
  });
  await page.addInitScript(() => {
    try {
      sessionStorage.setItem("lsm-journey-done", "1");
      localStorage.setItem("lsm-journey-done", "1");
      localStorage.setItem("lsm-client", "c1");
    } catch {
      /* storage blocked */
    }
  });
  return page;
}

const shot = (page, name) => page.screenshot({ path: join(outDir, name) });
const TS = '[role="dialog"][aria-label="Text studio"]';

async function openTextStudio(page) {
  const card = page.locator("#post-card-1");
  await card.waitFor({ state: "visible", timeout: 20000 });
  await card.getByRole("button", { name: /^Edit picture$/ }).click();
  const photo = page.locator('[role="dialog"][aria-label="Photo studio"]');
  await photo.waitFor({ state: "visible", timeout: 20000 });
  await photo.getByRole("button", { name: /Text studio/ }).click();
  const ts = page.locator(TS);
  await ts.waitFor({ state: "visible", timeout: 20000 });
  await page.waitForFunction(() => {
    const c = document.querySelector(".ts-stage canvas");
    return c && c.width > 1;
  });
  return ts;
}

/** The stage canvas as a PNG data URL once two reads in a row agree (the drawing has settled). */
async function settled(page) {
  const read = () =>
    page.evaluate(() => document.querySelector(".ts-stage canvas").toDataURL("image/png"));
  let a = await read();
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(350);
    const b = await read();
    if (a === b) return b;
    a = b;
  }
  return a;
}

/** Pixel difference of two canvas captures: pixels whose largest channel difference is over `tol`, the mean and the largest difference. */
async function diff(page, a, b, tol = 24) {
  return page.evaluate(
    async ({ a, b, tol }) => {
      const load = (src) =>
        new Promise((ok) => {
          const i = new Image();
          i.onload = () => ok(i);
          i.src = src;
        });
      const [ia, ib] = await Promise.all([load(a), load(b)]);
      const w = ia.naturalWidth;
      const h = ia.naturalHeight;
      const px = (img) => {
        const c = document.createElement("canvas");
        c.width = w;
        c.height = h;
        const x = c.getContext("2d");
        x.drawImage(img, 0, 0);
        return x.getImageData(0, 0, w, h).data;
      };
      const pa = px(ia);
      const pb = px(ib);
      let over = 0;
      let sum = 0;
      let max = 0;
      for (let i = 0; i < pa.length; i += 4) {
        const d = Math.max(
          Math.abs(pa[i] - pb[i]),
          Math.abs(pa[i + 1] - pb[i + 1]),
          Math.abs(pa[i + 2] - pb[i + 2]),
        );
        sum += d;
        if (d > max) max = d;
        if (d > tol) over++;
      }
      const total = w * h;
      return {
        size: `${w}x${h}`,
        pixels: total,
        over,
        overPct: Math.round((over / total) * 100000) / 1000,
        meanDiff: Math.round((sum / total) * 1000) / 1000,
        maxDiff: max,
        tol,
      };
    },
    { a, b, tol },
  );
}

/** The canvas pixel at a point given in the vector's own units of a layer (fit inside, unrotated). */
const pixelAt = (page, fx, fy) =>
  page.evaluate(
    ({ fx, fy }) => {
      const c = document.querySelector(".ts-stage canvas");
      const d = c
        .getContext("2d")
        .getImageData(Math.floor(c.width * fx), Math.floor(c.height * fy), 1, 1).data;
      return [d[0], d[1], d[2]];
    },
    { fx, fy },
  );
/** A point of a vector layer (view box units) as fractions of the canvas. */
const at = (layer, vb, ux, uy) => {
  const k = Math.min((layer.w * W) / vb[0], (layer.h * H) / vb[1]);
  const ox = layer.x * W + (layer.w * W - vb[0] * k) / 2;
  const oy = layer.y * H + (layer.h * H - vb[1] * k) / 2;
  return [(ox + ux * k) / W, (oy + uy * k) / H];
};
const near = (a, b, tol = 20) => a.every((v, i) => Math.abs(v - b[i]) <= tol);
const rows = (ts) => ts.locator(".ts-layers .ts-layer .ts-layer-name").allInnerTexts();
const pieceRows = (ts) => ts.locator(".ts-layers .ts-layer:has(.ts-layer-piece)").count();
const row = (ts, name) => ts.locator(".ts-layers .ts-layer", { hasText: name }).first();
/** A row's name side (its middle may be under the row's own buttons when it is hovered). */
const pick = (ts, name) => row(ts, name).click({ position: { x: 44, y: 17 } });
const lastToast = (page) =>
  page
    .locator("[data-sonner-toast]")
    .first()
    .innerText()
    .catch(() => "");
const designNow = () => state.plan[0].ov.design;
async function waitSaved(page) {
  await page
    .waitForFunction(
      () => document.querySelector('[aria-label="Text studio"] .ts-save')?.textContent === "Saved",
      null,
      { timeout: 10000 },
    )
    .catch(() => undefined);
  await page.waitForTimeout(300);
}
async function split(page, ts, rowName, expectPieces, label) {
  const before = await settled(page);
  const piecesBefore = await pieceRows(ts);
  await pick(ts, rowName);
  await ts
    .locator(".ts-layers .ts-vector-actions button", { hasText: "Split into layers" })
    .click();
  await page
    .waitForFunction(
      ({ n }) =>
        document.querySelectorAll('[aria-label="Text studio"] .ts-layers .ts-layer .ts-layer-piece')
          .length >= n,
      { n: piecesBefore + expectPieces },
      { timeout: 15000 },
    )
    .catch(() => undefined);
  const made = (await pieceRows(ts)) - piecesBefore;
  if (made !== expectPieces)
    errors.push(
      `${label}: expected ${expectPieces} pieces, got ${made} (${await lastToast(page)})`,
    );
  const after = await settled(page);
  const d = await diff(page, before, after);
  if (d.overPct > 0.5)
    errors.push(`${label}: the composition changed after the split (${JSON.stringify(d)})`);
  await writeFile(join(outDir, `${label}-before.png`), Buffer.from(before.split(",")[1], "base64"));
  await writeFile(join(outDir, `${label}-after.png`), Buffer.from(after.split(",")[1], "base64"));
  return { pieces: made, diff: d, toast: await lastToast(page) };
}

/* ───────────── 1440 ───────────── */
const page = await newPage({ width: 1440, height: 1000 });
try {
  await page.goto(`${url}/?client=c1&month=2026-10`, { waitUntil: "networkidle" });
  let ts = await openTextStudio(page);
  await ts.locator(".ts-layers .ts-layer").first().waitFor({ state: "visible", timeout: 15000 });
  result.layersAtStart = await rows(ts);
  const start = await settled(page);
  await shot(page, "1440-0-start.png");

  // Formats said plainly: the vector bar on an SVG layer, labelled.
  await pick(ts, "Sale badge");
  result.vectorBar = await ts.locator(".ts-layers .ts-vector-actions button").allInnerTexts();
  for (const label of ["Split into layers", "Remove background"])
    if (!result.vectorBar.some((t) => t.includes(label)))
      errors.push(
        `The Layers panel should offer "${label}" on an SVG layer (${result.vectorBar.join(", ")})`,
      );
  result.propertiesSection = await ts
    .locator(".ts-vector-section summary")
    .innerText()
    .catch(() => "");
  if (result.propertiesSection !== "Vector layers")
    errors.push(
      `Properties should show a "Vector layers" section, read "${result.propertiesSection}"`,
    );

  // 1. Split the badge (6 pieces: background, ring, disc, clipped stripes, stars through <use>, lettering) and the icon set (6 icons).
  result.badgeSplit = await split(page, ts, "Sale badge", 6, "1440-1-badge");
  result.badgeRows = await rows(ts);
  await shot(page, "1440-1-badge-split.png");
  result.iconSplit = await split(page, ts, "Shop icons", 6, "1440-2-icons");
  await shot(page, "1440-2-icons-split.png");

  // 2. The illustration's background (its sky), on the whole vector: highlighted, removed, undone, redone.
  const scene = DESIGN.layers[0];
  const skyPoint = at(scene, [800, 600], 60, 40);
  result.skyBefore = await pixelAt(page, ...skyPoint);
  await pick(ts, "Park illustration");
  await ts
    .locator(".ts-layers .ts-vector-actions button", { hasText: "Remove background" })
    .click();
  await ts.locator(".ts-bg-confirm").waitFor({ state: "visible", timeout: 10000 });
  result.sceneHighlight = {
    polygons: await ts.locator(".ts-bg-highlight polygon").count(),
    note: await ts.locator(".ts-bg-confirm .ts-bg-note").innerText(),
  };
  if (result.sceneHighlight.polygons !== 1)
    errors.push(
      `The sky should be highlighted before it is removed (${JSON.stringify(result.sceneHighlight)})`,
    );
  await shot(page, "1440-3-scene-background-highlight.png");
  const graphicsBefore = state.graphics.size;
  await ts.locator(".ts-bg-confirm button", { hasText: "Remove background" }).click();
  await ts.locator(".ts-bg-confirm").waitFor({ state: "detached", timeout: 10000 });
  await settled(page);
  result.skyAfter = await pixelAt(page, ...skyPoint);
  if (!isPhoto(result.skyAfter))
    errors.push(
      `After Remove background the photo should show where the sky was, read ${result.skyAfter}`,
    );
  result.sceneStoredCopy = state.graphics.size - graphicsBefore;
  await shot(page, "1440-3-scene-background-removed.png");
  await page.keyboard.press("Control+z");
  await settled(page);
  result.skyAfterUndo = await pixelAt(page, ...skyPoint);
  if (!near(result.skyAfterUndo, result.skyBefore, 6))
    errors.push(
      `Undo should bring the sky back, read ${result.skyAfterUndo} (was ${result.skyBefore})`,
    );
  await page.keyboard.press("Control+Shift+z");
  await settled(page);
  result.skyAfterRedo = await pixelAt(page, ...skyPoint);
  if (!isPhoto(result.skyAfterRedo))
    errors.push(`Redo should remove the sky again, read ${result.skyAfterRedo}`);
  result.sceneSplit = await split(page, ts, "Park illustration", 4, "1440-4-scene");
  await shot(page, "1440-4-scene-split.png");

  // 3. Badge pieces on their own: the stars moved, the inner disc recoloured, the stripes deleted, the background removed.
  const badge = DESIGN.layers[1];
  const discPoint = at(badge, [400, 400], 130, 130);
  const ringPoint = at(badge, [400, 400], 200, 62);
  result.discBefore = await pixelAt(page, ...discPoint);
  result.ringBefore = await pixelAt(page, ...ringPoint);
  await pick(ts, "Stars");
  const selectedStars = await ts.locator(".ts-sel").count();
  if (selectedStars !== 1)
    errors.push(
      `A row of the Layers list should select that piece alone, ${selectedStars} selected`,
    );
  for (let i = 0; i < 5; i++) await page.keyboard.press("Shift+ArrowRight");
  await pick(ts, "Inner disc");
  const swatch = ts.locator('.ts-vector-colours button.ts-swatch[aria-label="#FFCC00"]');
  await swatch.waitFor({ state: "visible", timeout: 5000 });
  await swatch.click();
  await page.locator('.ts-pop .ts-dot[title="Royal"]').click();
  await page.keyboard.press("Escape");
  await settled(page);
  result.discAfter = await pixelAt(page, ...discPoint);
  result.ringAfter = await pixelAt(page, ...ringPoint);
  if (!(result.discAfter[2] - result.discBefore[2] > 40))
    errors.push(
      `The inner disc should turn toward royal blue, read ${result.discBefore} → ${result.discAfter}`,
    );
  if (!near(result.ringAfter, result.ringBefore, 6))
    errors.push(
      `The ring (another piece with the same colour) should keep its colour, read ${result.ringBefore} → ${result.ringAfter}`,
    );
  await pick(ts, "Stripes");
  await row(ts, "Stripes").locator('button[aria-label="Delete"]').click();
  await settled(page);
  await shot(page, "1440-5-badge-pieces-edited.png");
  const cornerPoint = at(badge, [400, 400], 8, 8);
  result.badgeCornerBefore = await pixelAt(page, ...cornerPoint);
  await pick(ts, "Lettering");
  await ts
    .locator(".ts-layers .ts-vector-actions button", { hasText: "Remove background" })
    .click();
  await ts.locator(".ts-bg-confirm").waitFor({ state: "visible", timeout: 10000 });
  result.badgeHighlight = {
    polygons: await ts.locator(".ts-bg-highlight polygon").count(),
    note: await ts.locator(".ts-bg-confirm .ts-bg-note").innerText(),
  };
  await shot(page, "1440-6-badge-background-highlight.png");
  await ts.locator(".ts-bg-confirm button", { hasText: "Remove background" }).click();
  await settled(page);
  result.badgeCornerAfter = await pixelAt(page, ...cornerPoint);
  if (!near(result.badgeCornerBefore, [29, 53, 87], 12))
    errors.push(
      `The badge's corner should be its navy background first, read ${result.badgeCornerBefore}`,
    );
  if (!isPhoto(result.badgeCornerAfter))
    errors.push(
      `After Remove background the badge's corner should be the photo, read ${result.badgeCornerAfter}`,
    );
  await shot(page, "1440-6-badge-background-removed.png");

  // 4. Saved; reloaded; the same layers and pixels.
  await waitSaved(page);
  const beforeReload = await settled(page);
  result.savedLayers = designNow().layers.map(
    (l) => `${l.name}${l.piece ? " [piece]" : ""}${l.bgShape ? " [bg]" : ""}`,
  );
  const saved = designNow().layers;
  const stars = saved.find((l) => /^Stars/.test(l.name ?? ""));
  const disc = saved.find((l) => /^Inner disc/.test(l.name ?? ""));
  const ring = saved.find((l) => /^Ring · Sale badge/.test(l.name ?? ""));
  result.savedChecks = {
    starsX: stars?.x,
    discRecolor: disc?.recolor,
    ringRecolor: ring?.recolor ?? null,
    stripes: saved.some((l) => /^Stripes/.test(l.name ?? "")),
    background: saved.some((l) => l.bgShape && /Sale badge/.test(l.name ?? "")),
    pieceSrcs: [
      ...new Set(saved.filter((l) => l.piece).map((l) => l.src.replace(/id=.*/, "id=…"))),
    ],
  };
  if (result.savedChecks.stripes || result.savedChecks.background)
    errors.push(
      `The deleted stripes and the removed background should be gone from the saved design: ${JSON.stringify(result.savedChecks)}`,
    );
  if (!disc?.recolor || disc.recolor["#ffcc00"] !== "#1129d3")
    errors.push(
      `The disc's recolour should be saved on that piece only: ${JSON.stringify(result.savedChecks)}`,
    );
  if (ring?.recolor) errors.push("The ring should keep its own colours.");
  await page.reload({ waitUntil: "networkidle" });
  ts = await openTextStudio(page);
  await ts.locator(".ts-layers .ts-layer").first().waitFor({ state: "visible", timeout: 15000 });
  const afterReload = await settled(page);
  result.reloadRows = (await rows(ts)).length;
  result.reloadDiff = await diff(page, beforeReload, afterReload);
  if (result.reloadRows !== saved.length)
    errors.push(
      `After a reload the Text studio should show ${saved.length} layers, found ${result.reloadRows}`,
    );
  if (result.reloadDiff.overPct > 0.05)
    errors.push(
      `After a reload the design should look the same: ${JSON.stringify(result.reloadDiff)}`,
    );
  await shot(page, "1440-7-reloaded.png");
  await ts.locator(".ts-save-return").click();
  await ts.waitFor({ state: "detached", timeout: 15000 });
  result.afterSaveReturn = designNow().layers.length;
  ts = await openTextStudio(page);
  await ts.locator(".ts-layers .ts-layer").first().waitFor({ state: "visible", timeout: 15000 });
  result.reopenRows = (await rows(ts)).length;
  if (result.reopenRows !== saved.length)
    errors.push(
      `After Save & return and reopening: ${saved.length} layers expected, found ${result.reopenRows}`,
    );

  // Merge back the badge: one layer again, the same look.
  const beforeMerge = await settled(page);
  const rowsBeforeMerge = (await rows(ts)).length;
  await pick(ts, "Lettering");
  await ts.locator(".ts-layers .ts-vector-actions button", { hasText: "Merge back" }).click();
  await page
    .waitForFunction(
      (n) =>
        document.querySelectorAll('[aria-label="Text studio"] .ts-layers .ts-layer').length < n,
      rowsBeforeMerge,
      { timeout: 15000 },
    )
    .catch(() => undefined);
  const afterMerge = await settled(page);
  result.merge = {
    rowsBefore: rowsBeforeMerge,
    rowsAfter: (await rows(ts)).length,
    diff: await diff(page, beforeMerge, afterMerge),
    toast: await lastToast(page),
  };
  if (result.merge.rowsAfter !== rowsBeforeMerge - 3)
    errors.push(
      `Merge back should turn the 4 badge pieces into 1 layer: ${JSON.stringify(result.merge)}`,
    );
  if (result.merge.diff.overPct > 0.5)
    errors.push(`Merge back should keep the look: ${JSON.stringify(result.merge.diff)}`);
  await shot(page, "1440-8-merged.png");

  // 5. Add as separate layers, from the Assets tab: an SVG vector is split on arrival; an EPS-only file stays one picture and says why.
  await ts.locator(".ts-tabs button", { hasText: "Assets" }).click();
  await ts.locator(".ts-assets .fp-card").first().waitFor({ state: "visible", timeout: 10000 });
  await ts.locator(".ts-assets .fp-card", { hasText: "Sale badge set" }).click();
  result.assetActions = await ts
    .locator(".ts-assets .fp-footer .fp-actions button")
    .allInnerTexts();
  const piecesBeforeAdd = await pieceRows(ts);
  await ts.locator(".ts-assets .fp-footer button", { hasText: "Add as separate layers" }).click();
  await page.getByRole("button", { name: /^Download$/ }).click();
  await page
    .waitForFunction(
      (n) =>
        document.querySelectorAll('[aria-label="Text studio"] .ts-layers .ts-layer .ts-layer-piece')
          .length >=
        n + 6,
      piecesBeforeAdd,
      { timeout: 15000 },
    )
    .catch(() => undefined);
  result.addAsPieces = (await pieceRows(ts)) - piecesBeforeAdd;
  if (result.addAsPieces !== 6)
    errors.push(
      `"Add as separate layers" should place the badge as 6 pieces, got ${result.addAsPieces}`,
    );
  await shot(page, "1440-9-added-as-separate-layers.png");
  const rowsBeforeEps = (await rows(ts)).length;
  await ts.locator(".ts-assets .fp-card", { hasText: "Brush lettering" }).click();
  await ts.locator(".ts-assets .fp-footer button", { hasText: "Add as separate layers" }).click();
  await page.getByRole("button", { name: /^Download$/ }).click();
  await page.waitForTimeout(1500);
  result.eps = {
    rowsAdded: (await rows(ts)).length - rowsBeforeEps,
    toast: await page.locator("[data-sonner-toast]").allInnerTexts(),
  };
  if (result.eps.rowsAdded !== 1 || !result.eps.toast.some((t) => /EPS\/AI/.test(t)))
    errors.push(
      `An EPS-only vector should be added as one picture with the reason said: ${JSON.stringify(result.eps)}`,
    );
  await ts.locator(".ts-tabs button", { hasText: "Properties" }).click();
  await shot(page, "1440-10-eps-refused.png");
  await waitSaved(page);
  await ts.locator(".ts-save-return").click();
  await ts.waitFor({ state: "detached", timeout: 15000 });
  const sideways = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth + 1,
  );
  if (sideways) errors.push("1440: the page scrolls sideways.");
} catch (e) {
  errors.push(`1440: the flow stopped: ${e instanceof Error ? e.message : String(e)}`);
  await shot(page, "1440-failed.png").catch(() => undefined);
}
await page.close();

/* ───────────── The client's review link ───────────── */
const sharePage = await newPage({ width: 1280, height: 1000 });
try {
  state.shareLayer = [];
  await sharePage.goto(`${url}/share/${TOKEN}`, { waitUntil: "networkidle" });
  await sharePage.waitForTimeout(2500);
  const pieceIds = new Set(
    designNow()
      .layers.filter((l) => l.piece)
      .map((l) => l.id),
  );
  const served = state.shareLayer.filter((r) => pieceIds.has(r.id));
  result.share = {
    pieceLayers: pieceIds.size,
    requested: new Set(served.map((r) => r.id)).size,
    refused: state.shareLayer.filter((r) => r.status !== 200).length,
  };
  if (!result.share.requested || result.share.refused)
    errors.push(
      `The review link should draw the pieces through its layer route: ${JSON.stringify(result.share)}`,
    );
  await shot(sharePage, "share-review-link.png");
} catch (e) {
  errors.push(`share: ${e instanceof Error ? e.message : String(e)}`);
}
await sharePage.close();

/* ───────────── 390 ───────────── */
const narrow = await newPage({ width: 390, height: 844 });
try {
  await narrow.goto(`${url}/?client=c1&month=2026-10`, { waitUntil: "networkidle" });
  const ts = await openTextStudio(narrow);
  await ts.locator(".ts-tabs button", { hasText: "Layers" }).click();
  await ts.locator(".ts-layers .ts-layer").first().waitFor({ state: "visible", timeout: 15000 });
  await pick(ts, "Icon heart");
  const bar = ts.locator(".ts-layers .ts-vector-actions");
  await bar.waitFor({ state: "visible", timeout: 5000 });
  result.narrow = {
    bar: await bar.locator("button").allInnerTexts(),
    barInView: await bar.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return r.left >= 0 && r.right <= window.innerWidth + 1 && r.height > 0;
    }),
  };
  if (!result.narrow.bar.some((t) => t.includes("Merge back")))
    errors.push(`390: a piece should offer Merge back (${result.narrow.bar.join(", ")})`);
  if (!result.narrow.barInView) errors.push("390: the vector actions should fit the screen width.");
  await shot(narrow, "390-1-layers-vector-actions.png");
  await ts.locator(".ts-tabs button", { hasText: "Properties" }).click();
  await ts.locator(".ts-vector-section").waitFor({ state: "visible", timeout: 5000 });
  await ts.locator(".ts-vector-section").scrollIntoViewIfNeeded();
  result.narrow.properties = await ts.locator(".ts-vector-section button").allInnerTexts();
  await shot(narrow, "390-2-properties-vector-layers.png");
  result.narrow.sideways = await narrow.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth + 1,
  );
  if (result.narrow.sideways) errors.push("390: the page scrolls sideways.");
  const sr = await ts.locator(".ts-save-return").boundingBox();
  result.narrow.saveReturnVisible = !!sr && sr.x >= 0 && sr.x + sr.width <= 391 && sr.y >= 0;
  if (!result.narrow.saveReturnVisible) errors.push("390: Save & return should stay on screen.");
} catch (e) {
  errors.push(`390: the flow stopped: ${e instanceof Error ? e.message : String(e)}`);
  await shot(narrow, "390-failed.png").catch(() => undefined);
}
await narrow.close();

result.pieceCalls = state.pieceCalls;
result.graphicsStored = state.graphics.size;
result.planSaves = state.planSaves;
result.paidRoutes = state.paid;
if (state.paid.length) errors.push(`A paid route was reached: ${state.paid.join(", ")}`);
if (outside.length)
  errors.push(`Network calls outside the test server: ${[...new Set(outside)].join(", ")}`);
console.log(JSON.stringify(result, null, 2));
await writeFile(join(outDir, "result.json"), JSON.stringify({ result, errors }, null, 2));
await browser.close();
served.server.close();
if (errors.length) {
  console.error("FAILED:\n- " + errors.join("\n- "));
  process.exit(1);
}
console.log(`OK · screenshots in ${outDir}`);
