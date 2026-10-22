/**
 * A browser smoke test of the Direction board in headless Chromium: the built app (dist/client,
 * from `npm run build`) is served statically with the studio's boot answered by a mock (a signed-in
 * admin, one client with brand colours and two ambassadors, one month that follows a read grid, a
 * Drive listing of 67 photos and 119 photos Drive no longer gives). The workflow opens on
 * Direction and the script checks the Models row (chips with portraits, the picker with the
 * roster and its add button, the cast saved through the settings route), the Colours card (the
 * four sources with swatches, the grid's colours read from the grid, "Both" deduplicated, the
 * save carrying its source, no theme write-through), and the Drive picker (square tiles for the
 * photos and the placeholders, a visible kind label, the tab counting the 67 available photos,
 * the quiet "+119 no longer in Drive" note, the grid scrolling inside the dialog) at 1440 and
 * 390. Screenshots land in --out (default: ./smoke). No Worker, no D1, no wrangler and no
 * provider are involved: the mock is in this file, and any call outside it fails the run.
 *
 * Usage:  npm run build && node scripts/direction-smoke.mjs [--out dir]
 */
import { createServer } from "node:http";
import { execSync } from "node:child_process";
import { mkdir, readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { pathToFileURL } from "node:url";
import { deflateSync } from "node:zlib";

async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch {
    const root = execSync("npm root -g", { encoding: "utf8" }).trim();
    return import(pathToFileURL(join(root, "playwright", "index.mjs")).href);
  }
}
const { chromium } = await loadPlaywright();

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const outDir = opt("--out", join(process.cwd(), "smoke"));
await mkdir(outDir, { recursive: true });
const executablePath = process.env.PW_CHROMIUM || "/opt/pw-browsers/chromium";
const dist = join(process.cwd(), "dist", "client");

/** A real PNG of one flat colour (a product photo, a portrait, a grid), so an <img> has a size once loaded. */
function png(w, h, rgb) {
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
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set(rgb, y * (1 + w * 3) + 1 + x * 3);
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
/* Drive photos are wide, not square, so a square tile has to crop them (what the fix guarantees). */
const PHOTO = png(480, 320, [120, 110, 100]);
const PORTRAIT = png(300, 380, [90, 70, 60]);
const SQUARE = png(300, 300, [200, 190, 170]);

const NOW = Date.now();
const ADMIN = { id: "u1", email: "smoke@example.test", name: "Smoke", role: "admin" };
const BRAND = [
  { name: "Pistachio", hex: "#8fbf6a" },
  { name: "Cream", hex: "#f3ece0" },
];
const CLIENT = {
  id: "c1",
  slug: "habibah",
  name: "Habibah",
  logo: false,
  badge: false,
  colors: BRAND,
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
const OMAR = {
  id: "amb-omar",
  client: "c1",
  name: "Omar",
  description: "In his thirties, short black beard, warm smile",
  gender: "man",
  modest: true,
  hijab: false,
  image: true,
  position: 0,
  updated: NOW,
};
const LINA = {
  id: "amb-lina",
  client: "c1",
  name: "Lina",
  description: "In her late twenties, long dark hair",
  gender: "woman",
  modest: true,
  hijab: false,
  image: true,
  position: 1,
  updated: NOW,
};
let ambassadors = [OMAR, LINA];
const POSTS = [
  {
    index: 1,
    type: "lifestyle",
    title: "Pistachio week",
    brief: "Omar lifts the pistachio kunafa on marble.",
    caption: "",
    hashtags: "",
    product: "pistachio",
    people: ["Omar"],
    ideaAt: 1,
    tile: 1,
  },
  {
    index: 2,
    type: "product",
    title: "Walnut tray",
    brief: "The walnut tray on a cream cloth.",
    caption: "",
    hashtags: "",
    product: "walnut",
    ideaAt: 1,
    tile: 2,
  },
];
let config = {
  mode: "post",
  input: "model",
  prompt: "",
  ratio: "4:5",
  size: "1K",
  count: 2,
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
  postCount: 2,
  format: "4:5",
  model: "nano-banana-pro",
  plan: POSTS,
  plannedAt: 1,
  gridRef: "style:g1",
  ambassadors: ["amb-omar"],
};
const batch = () => ({
  id: "b1",
  name: "Habibah · October 2026",
  config: JSON.stringify(config),
  client: "c1",
  month: "2026-10",
  theme: null,
  state: "idle",
  last_error: null,
  created: NOW,
  updated: NOW,
});
const SOURCES = [
  {
    id: "s1",
    name: "pistachio.jpg",
    mime: "image/jpeg",
    size: 1000,
    role: "lead",
    kind: "product",
    created: NOW,
  },
  {
    id: "s2",
    name: "walnut.jpg",
    mime: "image/jpeg",
    size: 1000,
    role: "lead",
    kind: "product",
    created: NOW,
  },
];
const GRID_STYLE = {
  id: "g1",
  kind: "food",
  category: "grid",
  created: NOW,
  title: "Marble mornings",
  tags: "",
  position: 0,
  updated: NOW,
  score: 8,
  w: 1080,
  h: 1080,
  tiles: 9,
};
const tile = (n, kind, background, color) => ({
  n,
  position: `row ${Math.ceil(n / 3)}, col ${((n - 1) % 3) + 1}`,
  row: Math.ceil(n / 3),
  col: ((n - 1) % 3) + 1,
  kind,
  purpose: `Tile ${n}`,
  items: "",
  background,
  words: color ? "words at the bottom, medium" : "no words on it",
  colour: color ?? "",
  free: kind === "text",
});
const GRID_INFO = {
  ok: true,
  read: true,
  tiles: 9,
  kinds: [
    { kind: "product", n: 6 },
    { kind: "text", n: 2 },
    { kind: "place", n: 1 },
  ],
  textTiles: 2,
  layout: "3 rows × 3 columns",
  world: "Marble and walnut, warm morning light.",
  tileList: [
    tile(1, "product", "marble", "#111111"),
    tile(2, "text", "cream #f3ece0", "#5a3b2e"),
    tile(3, "product", "deep walnut #5a3b2e"),
    tile(4, "place", "the shop"),
    tile(5, "product", "marble"),
    tile(6, "text", "ink #111111", "#f3ece0"),
    tile(7, "product", "marble"),
    tile(8, "product", "linen"),
    tile(9, "product", "marble"),
  ],
  rows: 3,
  cols: 3,
};
/* 67 photos Drive gives today, 119 it no longer gives: the picker counts them apart. */
const photos = Array.from({ length: 67 }, (_, i) => ({
  id: `d${i + 1}`,
  file: `IMG_${1000 + i}.jpg`,
  name: i % 3 === 0 ? "Pistachio kunafa" : i % 3 === 1 ? "Walnut tray" : "Sidr honey",
  folder: "Products",
  w: 480,
  h: 320,
  modified: "2026-09-01",
  kind: i % 5 === 0 ? undefined : i % 2 ? "product" : "lifestyle",
  note: i % 2 ? "" : "on marble",
  role: "product",
}));
const missing = Array.from({ length: 119 }, (_, i) => ({
  id: `m${i + 1}`,
  file: `OLD_${i}.jpg`,
  name: "Older photo",
  folder: "Products",
  w: 480,
  h: 320,
  modified: "2025-01-01",
  kind: "product",
  role: "product",
  missing: true,
  reason: "Deleted in Drive.",
}));
const DRIVE = {
  link: "https://drive.google.com/drive/folders/x",
  email: "studio@example.test",
  folder: "Habibah",
  folders: [
    {
      id: "f1",
      name: "Habibah",
      link: "https://drive.google.com/drive/folders/x",
      role: "product",
      approved: true,
      default: true,
    },
  ],
  photos,
  groups: { product: photos, brand: [], reference: [], output: [] },
  missing,
  demo: false,
};

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
const saves = [];
const MOCK = () => ({
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
  "/api/studio/batch": { batch: batch(), sources: SOURCES, tasks: [] },
  "/api/studio/engine/models": { models: [] },
  "/api/studio/styles/pending": { n: 0 },
  "/api/studio/lessons/pending": { n: 0 },
  "/api/studio/posts/themes": { themes: [] },
  "/api/studio/posts/takes": { takes: [] },
  "/api/studio/posts/versions": { versions: [] },
  "/api/studio/posts/drafts": { draft: null },
  "/api/studio/posts/video/summary": { posts: {} },
  "/api/studio/posts/video/list": { videos: [] },
  "/api/studio/styles/lookup": { styles: [GRID_STYLE] },
  "/api/studio/styles/g1/grid": GRID_INFO,
  "/api/studio/styles/start-pictures": { brief: [], refs: [], style: null, grid: null },
  "/api/studio/references": { references: [] },
  "/api/studio/profiles/c1": { profile: null },
  "/api/studio/memory": { rules: [], lessons: [], notes: [], preferences: [] },
  "/api/studio/drive/c1": DRIVE,
  "/api/studio/drive/c1/folders": { folders: DRIVE.folders, demo: false },
  "/api/studio/ambassadors": { ambassadors },
  "/api/studio/publish/status": { connected: false },
  "/api/studio/publish": { publications: [] },
  "/api/studio/ocr/status": { connected: false, provider: "none", reason: "Not connected" },
  "/api/studio/photolab/status": {
    connected: false,
    provider: "demo",
    reason: "No key",
    prices: {},
    approximate: true,
    access: { admin: true, enabled: true, reason: "" },
  },
  "/api/studio/freepik/status": {
    connected: false,
    demo: true,
    reason: "No key",
    admin: true,
    access: "admin",
    plan: "unknown",
    planLabel: "",
    downloadEstimate: null,
    entitlements: {},
    mcp: { connected: false, url: "" },
    switch: { enabled: true, reason: "" },
  },
});

const readJson = (req) =>
  new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(raw || "{}"));
      } catch {
        resolve({});
      }
    });
  });

async function startStatic() {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const path = decodeURIComponent(url.pathname);
    const send = (body, status = 200) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (path.startsWith("/api/")) {
      if (path.startsWith("/api/studio/drive/photo/")) {
        res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" });
        res.end(PHOTO);
        return;
      }
      if (/^\/api\/studio\/ambassadors\/[^/]+\/image$/.test(path)) {
        res.writeHead(200, { "content-type": "image/png" });
        res.end(PORTRAIT);
        return;
      }
      if (path === "/api/studio/styles/g1/image" || path === "/api/studio/file") {
        res.writeHead(200, { "content-type": "image/png" });
        res.end(SQUARE);
        return;
      }
      // The saves the board makes: the palette with its source, and the cast through the settings route.
      if (path === "/api/studio/posts/palette" && req.method === "POST") {
        const d = await readJson(req);
        saves.push({ route: "palette", body: d });
        config = { ...config, palette: d.palette, paletteFrom: d.from ?? "manual" };
        return send({ ok: true, palette: d.palette, from: d.from ?? "manual" });
      }
      if (path === "/api/studio/posts/settings" && req.method === "PUT") {
        const d = await readJson(req);
        saves.push({ route: "settings", body: d });
        if (d.ambassadors) config = { ...config, ambassadors: d.ambassadors };
        return send({ ok: true });
      }
      if (path === "/api/studio/ambassadors" && req.method === "POST") {
        const d = await readJson(req);
        saves.push({ route: "ambassadors", body: d });
        ambassadors = [
          ...ambassadors,
          {
            ...LINA,
            id: `amb-${ambassadors.length + 1}`,
            name: d.name,
            description: "",
            gender: "",
            image: false,
            position: ambassadors.length,
          },
        ];
        return send({ ambassadors });
      }
      if (
        path === "/api/studio/posts/plan" ||
        path === "/api/studio/posts/shots" ||
        path === "/api/studio/posts/plan-preview"
      )
        return send({
          ok: true,
          posts: [],
          planned: 0,
          paid: 0,
          blocked: [],
          notes: [],
          issues: [],
          estimate: {
            model: "",
            size: "1K",
            perImage: 0,
            total: 0,
            maximum: 0,
            known: false,
            retakes: 0,
          },
          spend: { approved: 0, reserved: 0, remaining: 0 },
        });
      if (/\/grid-read$/.test(path)) {
        saves.push({ route: "grid-read", body: {} });
        return send(GRID_INFO);
      }
      const body = MOCK()[path] ?? (path.includes("/list") || path.endsWith("s") ? [] : {});
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
    const data = await readFile(file);
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    res.end(data);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

const served = await startStatic();
const url = served.url;
const browser = await chromium.launch({ executablePath, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
const outside = [];
page.on("pageerror", (e) => errors.push(`page error: ${String(e)}`));
page.on(
  "console",
  (m) =>
    m.type() === "error" &&
    !/favicon|404/.test(m.text()) &&
    errors.push(`console error: ${m.text()}`),
);
const ALLOWED = [
  url,
  "data:",
  "blob:",
  "https://fonts.googleapis.com/",
  "https://fonts.gstatic.com/",
];
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

/** A tile is square when its picture frame's width and height agree within 2 px and it is at least 60 px tall. */
async function tileShapes(scope) {
  return scope.locator(".drive-thumb-pic").evaluateAll((els) =>
    els.slice(0, 80).map((el) => {
      const r = el.getBoundingClientRect();
      return {
        w: Math.round(r.width),
        h: Math.round(r.height),
        blank: el.classList.contains("drive-thumb-blank"),
      };
    }),
  );
}
function checkSquares(shapes, where) {
  if (!shapes.length) return errors.push(`${where}: no tiles found`);
  const bad = shapes.filter((s) => Math.abs(s.w - s.h) > 2 || s.h < 60);
  if (bad.length)
    errors.push(
      `${where}: ${bad.length} of ${shapes.length} tiles are not square: ${JSON.stringify(bad.slice(0, 3))}`,
    );
}

const result = {};
try {
  await page.goto(`${url}/?client=c1&month=2026-10`, { waitUntil: "networkidle" });
  // The Studio's rail opens the workflow on Direction.
  const back = page.getByTitle("Back to Direction").first();
  await back.waitFor({ state: "visible", timeout: 20000 });
  await back.click();
  const flow = page.locator('[role="dialog"][aria-label="Create content"]');
  await flow.waitFor({ state: "visible", timeout: 20000 });
  await flow
    .getByRole("heading", { name: "Direction" })
    .waitFor({ state: "visible", timeout: 10000 });
  result.direction = true;

  /* ── Models ── */
  const modelsRow = flow.locator(".flow-models-row");
  await modelsRow.waitFor({ state: "visible", timeout: 10000 });
  result.modelsTitle = (await modelsRow.locator("b").first().innerText()).trim();
  const chips = modelsRow.locator(".flow-model-chip");
  result.modelChips = await chips.allInnerTexts();
  if (result.modelChips.length !== 1 || !/Omar/.test(result.modelChips[0]))
    errors.push(
      `The Models row should show Omar as the cast chip, saw ${JSON.stringify(result.modelChips)}`,
    );
  result.chipPortraits = await chips.locator("img").count();
  if (result.chipPortraits !== 1) errors.push("The cast chip should carry Omar's portrait.");
  await page.screenshot({ path: join(outDir, "direction-1440.png"), fullPage: true });
  await modelsRow.getByRole("button", { name: /Change models/ }).click();
  const picker = page.locator('[role="dialog"]').filter({ hasText: "Models for" });
  await picker.waitFor({ state: "visible", timeout: 10000 });
  result.pickerCards = await picker.locator(".amb-card").count();
  if (result.pickerCards !== 2)
    errors.push(`The models picker should list the 2 ambassadors, found ${result.pickerCards}`);
  result.pickerAddButton = await picker.getByRole("button", { name: /Ambassador/ }).count();
  if (!result.pickerAddButton) errors.push("The models picker should offer to add an ambassador.");
  // Ticking Lina saves the cast through the settings route (the classic journey's path).
  // The name sits in an input, which text filters do not see: Lina is the second card of the roster.
  const linaCard = picker.locator(".amb-card").nth(1);
  // The tick is controlled by the month's saved cast: it shows once the save and the refresh are through.
  const linaTick = linaCard.getByLabel("In this month");
  await linaTick.click();
  await page
    .waitForFunction((el) => el.checked, await linaTick.elementHandle(), { timeout: 5000 })
    .catch(() => errors.push("Lina's tick should show once the cast is saved."));
  const castSave = saves.find((s) => s.route === "settings" && s.body.ambassadors);
  result.castSaved = castSave?.body.ambassadors ?? null;
  if (
    !castSave ||
    JSON.stringify(castSave.body.ambassadors) !== JSON.stringify(["amb-omar", "amb-lina"])
  )
    errors.push(
      `Ticking Lina should save the cast [omar, lina] through /posts/settings, saw ${JSON.stringify(result.castSaved)}`,
    );
  await page.screenshot({ path: join(outDir, "direction-1440-models.png") });
  await picker.getByRole("button", { name: /^Done$/ }).click();
  await picker.waitFor({ state: "hidden", timeout: 5000 });
  await flow
    .locator(".flow-models-row .flow-model-chip", { hasText: "Lina" })
    .waitFor({ state: "visible", timeout: 5000 });
  result.chipsAfter = await flow.locator(".flow-models-row .flow-model-chip").allInnerTexts();

  /* ── Colours ── */
  const colours = flow.locator(".flow-colours");
  const sources = colours.getByRole("radio");
  result.sources = await sources.allInnerTexts();
  if (result.sources.length !== 4)
    errors.push(`The Colours card should offer 4 sources, found ${result.sources.length}`);
  for (const want of [
    "Client's brand colours",
    "The followed grid's colours",
    "Both",
    "Set by you",
  ])
    if (!result.sources.some((s) => s.includes(want)))
      errors.push(`Colour source missing: ${want}`);
  if (result.sources.some((s) => /theme/i.test(s)))
    errors.push("The theme palette must not be offered as a source.");
  result.defaultSource = (await colours.getByRole("radio", { checked: true }).innerText()).split(
    "\n",
  )[0];
  if (!/brand colours/.test(result.defaultSource))
    errors.push(`The default source should be the brand colours, saw "${result.defaultSource}"`);
  // The grid source shows the colours read from the grid (cream, walnut, ink), the brand its two.
  result.gridSwatches = await sources.nth(1).locator(".flow-source-swatches i").count();
  if (result.gridSwatches !== 3)
    errors.push(
      `The grid source should show 3 colours read from the grid, found ${result.gridSwatches}`,
    );
  result.brandSwatches = await sources.nth(0).locator(".flow-source-swatches i").count();
  if (result.brandSwatches !== 2)
    errors.push(`The brand source should show the 2 brand colours, found ${result.brandSwatches}`);
  // "Both" = brand first, then the grid's, cream once: 4 colours.
  result.bothSwatches = await sources.nth(2).locator(".flow-source-swatches i").count();
  if (result.bothSwatches !== 4)
    errors.push(`"Both" should show 4 colours (cream once), found ${result.bothSwatches}`);
  await sources.nth(2).click();
  await page.waitForTimeout(500);
  const paletteSave = saves.find((s) => s.route === "palette");
  result.paletteSaved = paletteSave?.body ?? null;
  if (!paletteSave || paletteSave.body.from !== "both" || paletteSave.body.palette.length !== 4)
    errors.push(
      `Choosing Both should save 4 colours with from "both", saw ${JSON.stringify(result.paletteSaved)}`,
    );
  if (paletteSave && "theme" in paletteSave.body)
    errors.push("The colours save must not carry a theme write-through.");
  await colours
    .locator(".flow-colour-source.on", { hasText: "Both" })
    .waitFor({ state: "visible", timeout: 5000 });
  result.monthSwatches = await colours.locator(".flow-swatches .flow-swatch").count();
  if (result.monthSwatches !== 4)
    errors.push(`After Both the month's swatches should be 4, found ${result.monthSwatches}`);
  result.colourNote = (await colours.locator("small.flow-muted").first().innerText()).trim();
  if (!/brand colours, then the grid's/.test(result.colourNote))
    errors.push(`The note should name the source, saw "${result.colourNote}"`);
  await page.screenshot({ path: join(outDir, "direction-1440-colours.png") });
  // Set by you opens the editor without a theme checkbox.
  await sources.nth(3).click();
  await colours.locator(".flow-colour-edit").waitFor({ state: "visible", timeout: 5000 });
  result.themeCheckbox = await colours.locator(".flow-colour-edit input[type=checkbox]").count();
  if (result.themeCheckbox) errors.push("The colour editor must not offer to update the theme.");
  await colours.getByRole("button", { name: "Keep as they are" }).click();

  /* ── Drive picker ── */
  await flow.getByRole("button", { name: /^Choose from Drive$/ }).click();
  const drive = page.locator(".drive-dialog");
  await drive.waitFor({ state: "visible", timeout: 10000 });
  await drive
    .locator(".drive-grid .drive-thumb")
    .first()
    .waitFor({ state: "visible", timeout: 15000 });
  result.driveDescription = (
    await drive.locator('[data-slot="dialog-description"]').innerText()
  ).trim();
  const productTab = drive.getByRole("tab", { name: /Product photos/ });
  result.productTab = (await productTab.innerText()).replace(/\s+/g, " ").trim();
  if (!/67(?!\d)/.test(result.productTab) || /186/.test(result.productTab))
    errors.push(
      `The Product photos tab should count the 67 available photos, saw "${result.productTab}"`,
    );
  result.missingNote = (await drive.locator(".drive-missing-note").innerText())
    .replace(/\s+/g, " ")
    .trim();
  if (
    !/\+119 no longer in Drive/.test(result.missingNote) ||
    !/kept for the months that used them/.test(result.missingNote)
  )
    errors.push(
      `The missing note should read "+119 no longer in Drive, kept for the months that used them", saw "${result.missingNote}"`,
    );
  result.tiles1440 = await drive.locator(".drive-grid .drive-thumb").count();
  const shapes = await tileShapes(drive);
  result.tileSample = shapes.slice(0, 2);
  checkSquares(shapes, "1440");
  result.blankTiles = shapes.filter((s) => s.blank).length;
  if (!result.blankTiles)
    errors.push(
      "The placeholders of the photos Drive no longer gives should render as square tiles too.",
    );
  result.kindLabel = (
    await drive.locator(".drive-grid .drive-thumb .drive-thumb-kind").nth(1).innerText()
  ).trim();
  if (!result.kindLabel) errors.push("A tile should show its kind label.");
  const kindVisible = await drive
    .locator(".drive-grid .drive-thumb .drive-thumb-kind")
    .nth(1)
    .evaluate((el) => el.getBoundingClientRect().height > 8);
  if (!kindVisible) errors.push("The kind label should be visible, not collapsed.");
  // The grid scrolls inside the dialog: it has its own overflow and the actions stay in view.
  result.gridScroll = await drive
    .locator(".drive-grid")
    .evaluate((el) => ({
      scroll: el.scrollHeight > el.clientHeight,
      overflowY: getComputedStyle(el).overflowY,
      h: Math.round(el.clientHeight),
    }));
  if (!result.gridScroll.scroll || result.gridScroll.overflowY !== "auto")
    errors.push(
      `The Drive grid should scroll inside the dialog: ${JSON.stringify(result.gridScroll)}`,
    );
  const addButton = drive
    .getByRole("button", { name: /Add .*to this month|Pick the best/ })
    .first();
  result.actionsInView = await addButton.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return r.top >= 0 && r.bottom <= window.innerHeight;
  });
  if (!result.actionsInView)
    errors.push("The Drive picker's actions should stay in view under the grid at 1440.");
  await page.screenshot({ path: join(outDir, "drive-1440.png") });

  // 390 px: the tiles stay square, nothing scrolls sideways.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(600);
  const shapes390 = await tileShapes(drive);
  checkSquares(shapes390, "390");
  result.tile390 = shapes390[0];
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth + 1,
  );
  if (overflow) errors.push("The page scrolls sideways at 390 px.");
  // Which elements reach past the dialog's right edge, so a sideways overflow names its cause.
  const wide = await drive.evaluate((el) => {
    const edge = el.getBoundingClientRect().right;
    return el.scrollWidth > el.clientWidth + 1
      ? [...el.querySelectorAll("*")]
          .filter((x) => x.getBoundingClientRect().right > edge + 1)
          .slice(0, 6)
          .map(
            (x) =>
              `${x.tagName.toLowerCase()}.${[...x.classList].join(".")}@${Math.round(x.getBoundingClientRect().right - edge)}px`,
          )
      : [];
  });
  if (wide.length)
    errors.push(
      `The Drive dialog's content is wider than the dialog at 390 px: ${wide.join(", ")}`,
    );
  await page.screenshot({ path: join(outDir, "drive-390.png") });
  await page.keyboard.press("Escape");
  await drive.waitFor({ state: "hidden", timeout: 5000 });
  await page.screenshot({ path: join(outDir, "direction-390.png") });
  result.sources390 = await flow.locator(".flow-colours").getByRole("radio").count();
  result.modelsRow390 = await flow.locator(".flow-models-row").isVisible();
  // The board scrolls inside its overlay: the Models row and the Colours card, each brought into view.
  await flow.locator(".flow-models-row").scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(outDir, "direction-390-models.png") });
  await flow.locator(".flow-colours").scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(outDir, "direction-390-colours.png") });
  // The board's body (the top bar's chips are a known, older squeeze at 390 and not part of this check).
  const boardWide = await flow.locator(".journey-body").evaluate((el) => {
    const edge = el.getBoundingClientRect().right;
    return el.scrollWidth > el.clientWidth + 1
      ? [...el.querySelectorAll("*")]
          .filter((x) => x.getBoundingClientRect().right > edge + 1)
          .slice(0, 8)
          .map(
            (x) =>
              `${x.tagName.toLowerCase()}.${[...x.classList].join(".")}@${Math.round(x.getBoundingClientRect().right - edge)}px`,
          )
      : [];
  });
  if (boardWide.length)
    errors.push(
      `The Direction board's content is wider than the screen at 390 px: ${boardWide.join(", ")}`,
    );
} catch (e) {
  errors.push(`The flow stopped: ${e instanceof Error ? e.message : String(e)}`);
  await page.screenshot({ path: join(outDir, "direction-failed.png") }).catch(() => undefined);
}

result.saves = saves.map((s) => s.route);
console.log(JSON.stringify(result, null, 2));
if (saves.some((s) => s.route === "grid-read"))
  errors.push("The grid was read already: the board must not ask for a new reading by itself.");
if (outside.length)
  errors.push(`Network calls outside the test server: ${[...new Set(outside)].join(", ")}`);
await browser.close();
served.server.close();
if (errors.length) {
  console.error("FAILED:\n- " + errors.join("\n- "));
  process.exit(1);
}
console.log(`OK · screenshots in ${outDir}`);
