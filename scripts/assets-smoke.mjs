/**
 * A browser smoke test of Freepik assets as design elements, in headless Chromium against the
 * built app (dist/client, from `npm run build`) with every API answered by a mock in this file (a
 * signed-in admin, one client, one month with one post and its picture, a Freepik catalogue of
 * icons and textures). Nothing reaches a Worker, D1, Freepik or any provider.
 *
 * The flow: the Photo studio's Assets panel searches once; the selected asset's actions stay in
 * the sticky footer with the results scrolled to the top and to the bottom; "Add as layer"
 * downloads once (after the confirm) and opens the Text studio with the icon already placed (the
 * canvas pixel is the icon's lime); its vector colour is changed (the pixel follows); the same
 * search and selection are there in the Text studio's Assets tab without a second search; a
 * texture is set as the background (bottom of the layers, behind the photo); a text layer is
 * added. Then the same at 390 × 844. Screenshots land in --out (default: ./test-results).
 *
 * Usage:  npm run build && node scripts/assets-smoke.mjs [--out dir]
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
const outDir = opt("--out", join(process.cwd(), "test-results"));
await mkdir(outDir, { recursive: true });
const executablePath = process.env.PW_CHROMIUM || "/opt/pw-browsers/chromium";
const dist = join(process.cwd(), "dist", "client");

/** A real PNG in one colour with a darker band (the post's photo, or a texture). */
function png(w, h, rgb = [120, 110, 100], band = [70, 60, 50]) {
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
    out.set([...type].map((ch) => ch.charCodeAt(0)), 4);
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
    for (let x = 0; x < w; x++) raw.set(y > h * 0.4 && y < h * 0.6 ? band : rgb, y * (1 + w * 3) + 1 + x * 3);
  const idat = new Uint8Array(deflateSync(raw));
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", new Uint8Array())];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return Buffer.from(out);
}
const PICTURE = png(540, 675);
const TEXTURE = png(400, 500, [150, 150, 156], [130, 130, 136]);
const LIGHTNING = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="400" height="400"><path d="M58 4 L20 56 L46 56 L38 96 L80 40 L54 40 Z" fill="#c6f432" stroke="#111111" stroke-width="3" stroke-linejoin="round"/></svg>';
const iconSvg = (i) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="300" height="300"><rect width="100" height="100" fill="#f4f4f6"/><circle cx="50" cy="50" r="${18 + (i % 5) * 5}" fill="hsl(${(i * 37) % 360}, 70%, 50%)"/></svg>`;

const NOW = Date.now();
const ADMIN = { id: "u1", email: "smoke@example.test", name: "Smoke", role: "admin" };
const CLIENT = { id: "c1", slug: "habibah", name: "Habibah", logo: false, badge: false, colors: [{ name: "Pistachio", hex: "#8fbf6a" }, { name: "Royal", hex: "#1129d3" }], fonts: {}, tone: "", dos: "", donts: "", style: "", gridRhythm: "", language: "en", status: "active", position: 0, batches: 1, updated: NOW, overlay: null, fontFiles: [], places: [] };
const POST = { index: 1, type: "offer", title: "Move your way", brief: "A runner in the studio.", caption: "", hashtags: "", product: "pistachio", headline: "MOVE YOUR WAY", subline: "", ideaAt: 1 };
const CONFIG = { mode: "post", input: "model", prompt: "", ratio: "4:5", size: "1K", count: 1, backdrop: "", market: "auto", skill: "editorial", economy: false, output: "jpg", outputQuality: 90, outputSize: "fit", colors: "", modelDescription: "", center: true, client: "c1", month: "2026-10", postCount: 1, format: "4:5", model: "nano-banana-pro", plan: [POST], plannedAt: 1 };
const BATCH = { id: "b1", name: "Habibah · October 2026", config: JSON.stringify(CONFIG), client: "c1", month: "2026-10", theme: null, state: "idle", last_error: null, created: NOW, updated: NOW };
const TASK = { id: "t1", source: "s1", card: 1, status: "ready", output: "u1/b1/output/t1/a.png", qa: JSON.stringify({ automated: true, flags: [], notes: "Looks right.", found: true, count: 1, box: [], productConcern: false, centered: true }), error: null, prompt: "", attempts: 1, request_id: null, brief: null, cost: 0.04, updated: NOW, post: 1, made_for: 1 };
const SOURCE = { id: "s1", name: "pistachio.jpg", mime: "image/jpeg", size: 1000, role: "lead", kind: "product", created: NOW };
const RESULT_URL = `/api/studio/file?batch=b1&id=t1&kind=result&v=a.png`;

/** The catalogue: a lightning icon first, a concrete texture, and enough icons for the results to scroll. */
const lic = (premium) => ({ type: premium ? "premium" : "freemium", attribution: !premium, uses: [], url: "https://www.freepik.com/legal/terms-of-use" });
const ITEMS = [
  { id: "701", kind: "vector", title: "Lightning icon", author: "Vectorist", license: lic(false), preview: "/fp/preview/701.svg", width: 1000, height: 1000, orientation: "square", flattened: false, formats: ["svg", "eps"], url: "", demo: false },
  { id: "710", kind: "photo", title: "Concrete wall texture", author: "Studio A", license: lic(true), preview: "/fp/preview/710.png", width: 2400, height: 3000, orientation: "portrait", flattened: true, formats: ["jpg"], url: "", demo: false },
  ...Array.from({ length: 22 }, (_, i) => ({ id: String(720 + i), kind: "vector", title: `Round badge ${i + 1}`, author: "Vectorist", license: lic(i % 2 === 0), preview: `/fp/preview/${720 + i}.svg`, width: 800, height: 800, orientation: "square", flattened: false, formats: i % 3 ? ["svg", "eps"] : ["eps"], url: "", demo: false })),
];
const asset = (it, stored) => ({ id: `a${it.id}`, client: "c1", providerId: it.id, kind: it.kind, title: it.title, author: it.author, license: it.license, preview: it.preview, file: stored ? `/api/studio/freepik/assets/a${it.id}/file` : null, stored, mime: it.kind === "vector" ? "application/zip" : "image/png", width: it.width, height: it.height, flattened: it.kind !== "vector", layerable: true, format: it.kind === "vector" ? "SVG" : "PNG", contents: it.kind === "vector" ? ["eps", "svg"] : [], editable: it.kind === "vector", colors: it.kind === "vector" ? ["#c6f432", "#111111"] : [], formatNote: it.kind === "vector" ? "Vector bundle with an SVG: the SVG is placed as an editable vector; the EPS/AI files stay in the library." : "A picture (JPG/PNG): placed as it is; its colours cannot be changed here.", layerSrc: it.id === "701" ? "/fp/layer/icon.svg" : "/fp/layer/texture.png", lettering: false, demo: false });
const layerOf = (it) =>
  it.id === "701"
    ? { src: "/fp/layer/icon.svg", name: it.title, flattened: false, layerable: true, preview: false, format: "SVG", editable: true, colors: ["#c6f432", "#111111"], note: "Vector bundle with an SVG: the SVG is placed as an editable vector; the EPS/AI files stay in the library.", lettering: false, kind: "vector", aspect: 1 }
    : { src: "/fp/layer/texture.png", name: it.title, flattened: true, layerable: true, preview: false, format: "PNG", editable: false, colors: [], note: "A picture (JPG/PNG): placed as it is; its colours cannot be changed here.", lettering: false, kind: "photo", aspect: 0.8 };

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".woff2": "font/woff2", ".json": "application/json", ".ico": "image/x-icon" };
const calls = { search: 0, download: [], use: [], plan: 0, paid: [] };
const stored = new Set();
const MOCK = {
  "/api/auth/me": { user: ADMIN, registrationOpen: false },
  "/api/studio/state": { user: ADMIN, batches: [BATCH], trash: [], spend: [], spendThreshold: 20, clients: [CLIENT], engine: { model: "nano-banana-pro", configured: false, source: "none", openai: "none", google: "none", fal: "none", review: false, vertex: null }, preview: true, workflowV2: true },
  "/api/studio/batch": { batch: BATCH, sources: [SOURCE], tasks: [TASK] },
  "/api/studio/engine/models": { models: [] },
  "/api/studio/styles/pending": { n: 0 },
  "/api/studio/lessons/pending": { n: 0 },
  "/api/studio/posts/themes": { themes: [] },
  "/api/studio/posts/takes": { takes: [{ id: "tk1", index: 1, status: "made", key: TASK.output, image: RESULT_URL, cost: 0.04, note: "first take", madeFor: 1, created: NOW - 60000, current: true }] },
  "/api/studio/posts/versions": { versions: [] },
  "/api/studio/posts/video/summary": { posts: {} },
  "/api/studio/posts/video/list": { videos: [] },
  "/api/studio/photolab/status": { connected: false, provider: "demo", reason: "No Freepik key saved: every run is a demo.", prices: {}, approximate: true, access: { admin: true, enabled: true, reason: "" } },
  "/api/studio/photolab/jobs": { jobs: [] },
  "/api/studio/freepik/status": { connected: true, demo: false, reason: "", admin: true, access: "admin", plan: "premium", planLabel: "", downloadEstimate: 0, entitlements: {}, mcp: { connected: false, url: "" }, switch: { enabled: true, reason: "" } },
  "/api/studio/freepik/assets": { assets: [] },
  "/api/studio/drive/c1": { groups: { product: [], reference: [] }, photos: [], missing: [], demo: true },
  "/api/studio/ambassadors": { ambassadors: [] },
  "/api/studio/publish/status": { connected: false },
  "/api/studio/publish": { publications: [] },
  "/api/studio/ocr/status": { connected: false, provider: "none", reason: "Not connected" },
  "/api/studio/photo/tools/catalog": { ok: true, admin: true, tools: [], higgsfield: { provider: "higgsfield", connected: false, enabled: true, admin: true, reason: "", balance: null, available: {} }, magnific: { provider: "magnific", connected: false, enabled: true, admin: true, reason: "", balance: null, available: {} }, upscalePresets: [], upscaleModes: [], retouchModels: [], cachedAt: NOW },
  "/api/studio/photo/tools/jobs": { ok: true, jobs: [] },
};
/** Routes that make a picture or spend: none may be reached by layer or background work. */
const PAID = [/\/posts\/revise/, /\/posts\/generate/, /\/photolab\/run/, /\/photo\/tools\/run/, /\/engine\/(run|generate)/, /\/posts\/remake/];

const readBody = (req) => new Promise((ok) => {
  let s = "";
  req.on("data", (c) => (s += c));
  req.on("end", () => ok(s ? JSON.parse(s) : {}));
});

async function startStatic() {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const path = decodeURIComponent(url.pathname);
    const send = (status, body, type = "application/json") => {
      res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
      res.end(type === "application/json" ? JSON.stringify(body) : body);
    };
    if (path.startsWith("/fp/preview/")) {
      const id = path.slice("/fp/preview/".length).replace(/\.\w+$/, "");
      if (id === "701") return send(200, LIGHTNING, "image/svg+xml");
      if (id === "710") return send(200, TEXTURE, "image/png");
      return send(200, iconSvg(Number(id)), "image/svg+xml");
    }
    if (path === "/fp/layer/icon.svg") return send(200, LIGHTNING, "image/svg+xml");
    if (path === "/fp/layer/texture.png") return send(200, TEXTURE, "image/png");
    if (path.startsWith("/api/")) {
      if (PAID.some((r) => r.test(path))) calls.paid.push(path);
      if (path === "/api/studio/freepik/search") {
        calls.search++;
        return send(200, { items: ITEMS, page: 1, lastPage: 1, total: ITEMS.length, demo: false, connected: true, downloadEstimate: 0 });
      }
      if (path === "/api/studio/freepik/download") {
        const b = await readBody(req);
        calls.download.push(b);
        const it = ITEMS.find((x) => x.id === b.id);
        if (!b.confirm && !stored.has(b.id)) return send(409, { error: "Confirm the download.", needsConfirm: true, estimate: 0, asset: asset(it, false) });
        const reused = stored.has(b.id);
        stored.add(b.id);
        return send(200, { ok: true, asset: asset(it, true), reused, estimate: 0 });
      }
      if (path === "/api/studio/freepik/use") {
        const b = await readBody(req);
        calls.use.push(b);
        const it = ITEMS.find((x) => `a${x.id}` === b.asset);
        return send(200, { ok: true, asset: asset(it, true), use: { id: "u", role: b.role, batch: "b1", post: 1, slide: null, layerId: b.layerId ?? null }, ...(b.role === "design" ? { layer: layerOf(it) } : { reference: { key: "styles/x.png", thumb: "styles/x-thumb.jpg", name: it.title, at: NOW, source: "freepik" } }) });
      }
      if (path === "/api/studio/posts/plan" && req.method === "PUT") {
        await readBody(req);
        calls.plan++;
        return send(200, { ok: true });
      }
      if (path === "/api/studio/file") return send(200, PICTURE, "image/png");
      const body = MOCK[path] ?? (path.includes("/list") || path.endsWith("s") ? [] : {});
      return send(200, body);
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
const errors = [];
const outside = [];
const ALLOWED = [url, "data:", "blob:", "https://fonts.googleapis.com/", "https://fonts.gstatic.com/"];
const result = {};

/** Is the selected asset's footer in view, inside its panel, clear of the canvas and of the last result? */
async function footerCheck(page, scope, stageSel, label) {
  return page.evaluate(
    ({ scope, stageSel }) => {
      const root = document.querySelector(scope);
      const footer = root?.querySelector(".fp-footer");
      const results = root?.querySelector(".fp-results");
      const stage = document.querySelector(stageSel);
      if (!footer || !results) return { ok: false, why: "no footer or results" };
      const vh = window.innerHeight;
      const vw = window.innerWidth;
      const f = footer.getBoundingClientRect();
      const inView = f.top >= 0 && f.bottom <= vh + 1 && f.left >= -1 && f.right <= vw + 1 && f.height > 0;
      const s = stage?.getBoundingClientRect();
      const overCanvas = !!s && f.left < s.right - 1 && f.right > s.left + 1 && f.top < s.bottom - 1 && f.bottom > s.top + 1;
      results.scrollTop = 0;
      const atTop = footer.getBoundingClientRect();
      results.scrollTop = results.scrollHeight;
      const atBottom = footer.getBoundingClientRect();
      const cards = results.querySelectorAll(".fp-card");
      const last = cards[cards.length - 1]?.getBoundingClientRect();
      const r = results.getBoundingClientRect();
      const lastVisible = !!last && last.bottom <= r.bottom + 1 && last.bottom <= atBottom.top + 1;
      const scrolls = results.scrollHeight > results.clientHeight;
      const actions = [...footer.querySelectorAll(".fp-actions button")].map((b) => ({ text: b.textContent.trim(), visible: b.getBoundingClientRect().bottom <= vh + 1 && b.getBoundingClientRect().height > 0 }));
      return { ok: inView && !overCanvas && lastVisible && atTop.top === atBottom.top, inView, overCanvas, lastVisible, scrolls, footerTopAtTop: Math.round(atTop.top), footerTopAtBottom: Math.round(atBottom.top), vh, actions };
    },
    { scope, stageSel },
  ).then((r) => {
    if (!r.ok) errors.push(`${label}: the footer should stay in view, off the canvas, with the last result visible above it: ${JSON.stringify(r)}`);
    return r;
  });
}

/** The colour of the Text studio canvas at a point given in fractions of the canvas. */
const canvasPixel = (page, fx, fy) =>
  page.evaluate(
    ({ fx, fy }) => {
      const c = document.querySelector(".ts-stage canvas");
      const d = c.getContext("2d").getImageData(Math.floor(c.width * fx), Math.floor(c.height * fy), 1, 1).data;
      return [d[0], d[1], d[2]];
    },
    { fx, fy },
  );
const near = (a, b, tol = 24) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

async function run(viewport, tag) {
  const page = await browser.newPage({ viewport });
  page.on("pageerror", (e) => errors.push(`${tag} page error: ${String(e)}`));
  page.on("console", (m) => m.type() === "error" && !/favicon|404|409/.test(m.text()) && errors.push(`${tag} console error: ${m.text()}`));
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
  const r = (result[tag] = {});
  const narrow = viewport.width <= 640;
  calls.search = 0;
  calls.download = [];
  calls.use = [];
  stored.clear();
  try {
    await page.goto(`${url}/?client=c1&month=2026-10`, { waitUntil: "networkidle" });
    const editPicture = page.getByRole("button", { name: /^Edit picture$/ }).first();
    await editPicture.waitFor({ state: "visible", timeout: 20000 });
    await editPicture.click();
    const ps = page.locator('[role="dialog"][aria-label="Photo studio"]');
    await ps.waitFor({ state: "visible", timeout: 20000 });
    if (narrow) await ps.locator(".ps-bottom button", { hasText: "Assets" }).click();
    else await ps.locator(".ps-rail button", { hasText: "Assets" }).click();
    await ps.locator(".fp-card").first().waitFor({ state: "visible", timeout: 10000 });
    r.cards = await ps.locator(".fp-card").count();
    r.chips = await ps.locator(".fp-chips button").allInnerTexts();
    if (r.chips.join("|") !== "All|Icons|Photos|Backgrounds|Textures|Typography") errors.push(`${tag}: the filter chips read ${r.chips.join(", ")}`);
    r.sourceTabs = await ps.locator(".ps-asset-tabs button").allInnerTexts();
    // Nothing selected yet: the footer is there, its actions waiting.
    await ps.locator(".fp-card", { hasText: "Lightning icon" }).click();
    r.photoFooter = await footerCheck(page, '[aria-label="Photo studio"] .ps-assets', ".ps-stage", `${tag} Photo studio`);
    r.panelOverflow = await page.evaluate(() => {
      const side = document.querySelector('[aria-label="Photo studio"] .ts-side-body');
      const over = [...side.querySelectorAll(".fp-panel *")].filter((el) => !el.closest(".fp-chips") && el.getBoundingClientRect().right > side.getBoundingClientRect().right + 1).map((el) => `${el.tagName.toLowerCase()}.${el.className}`);
      return over.slice(0, 6);
    });
    if (r.panelOverflow.length) errors.push(`${tag}: the Assets panel spills out of its column: ${r.panelOverflow.join(", ")}`);
    await page.waitForTimeout(600);
    await page.screenshot({ path: join(outDir, `assets-${tag}-photo-studio.png`) });
    r.footerActions = await ps.locator(".fp-footer .fp-actions button").allInnerTexts();
    for (const a of ["Add as layer", "Set as background", "Use as reference", "Save to library"]) if (!r.footerActions.some((t) => t.includes(a))) errors.push(`${tag}: the footer lacks "${a}" (${r.footerActions.join(", ")})`);

    // Add as layer: the confirm (in the plan, no credits), one download, one use, then the Text studio with the icon placed.
    await ps.locator(".fp-footer button", { hasText: "Add as layer" }).click();
    const confirm = page.getByRole("button", { name: /^Download$/ });
    await confirm.waitFor({ state: "visible", timeout: 5000 });
    await confirm.click();
    const ts = page.locator('[role="dialog"][aria-label="Text studio"]');
    await ts.waitFor({ state: "visible", timeout: 20000 });
    await page.waitForFunction(() => {
      const c = document.querySelector(".ts-stage canvas");
      return c && c.width > 1;
    });
    await page.waitForTimeout(1200);
    r.downloadsAfterAdd = calls.download.length;
    r.usesAfterAdd = calls.use.map((u) => u.role);
    const iconPixel = await canvasPixel(page, 0.5, 0.5);
    r.iconPixel = iconPixel;
    if (!near(iconPixel, [198, 244, 50])) errors.push(`${tag}: the icon should be drawn over the photo (lime at the centre), read ${iconPixel}`);
    if (narrow) await ts.locator(".ts-tabs button", { hasText: "Layers" }).click();
    r.layers = await ts.locator(".ts-layer .ts-layer-name").allInnerTexts().catch(() => []);
    if (!r.layers.some((n) => /Lightning icon/.test(n))) errors.push(`${tag}: the layers list should show the icon, read ${r.layers.join(", ")}`);
    r.freepikBadge = await ts.locator(".ts-layer .src-badge.freepik").count();
    if (!r.freepikBadge) errors.push(`${tag}: the icon's row should carry the Freepik badge.`);
    // Select the icon's row, then its Vector colours: the lime becomes the brand's Royal blue.
    await ts.locator(".ts-layer", { hasText: "Lightning icon" }).click();
    await ts.locator(".ts-tabs button", { hasText: "Properties" }).click();
    const swatch = ts.locator('button.ts-swatch[aria-label="#C6F432"]');
    await swatch.waitFor({ state: "visible", timeout: 5000 });
    await swatch.click();
    await page.locator('.ts-pop .ts-dot[title="Royal"]').click();
    await page.keyboard.press("Escape");
    await page.waitForTimeout(900);
    const recoloured = await canvasPixel(page, 0.5, 0.5);
    r.recolouredPixel = recoloured;
    if (!near(recoloured, [17, 41, 211])) errors.push(`${tag}: after the colour change the icon's centre should be royal blue, read ${recoloured}`);
    await page.screenshot({ path: join(outDir, `assets-${tag}-text-studio-recolour.png`) });

    // The Assets tab: the same results and selection, no second search.
    const searchesBefore = calls.search;
    await ts.locator(".ts-tabs button", { hasText: "Assets" }).click();
    await ts.locator(".ts-assets .fp-card").first().waitFor({ state: "visible", timeout: 10000 });
    r.searchesInTextStudio = calls.search - searchesBefore;
    if (r.searchesInTextStudio !== 0) errors.push(`${tag}: the Text studio searched again (${r.searchesInTextStudio}) instead of carrying the results over.`);
    r.carriedSelection = await ts.locator(".ts-assets .fp-footer .fp-selected-text b").innerText().catch(() => "");
    if (!/Lightning icon/.test(r.carriedSelection)) errors.push(`${tag}: the selected asset should be carried over, read "${r.carriedSelection}"`);
    r.textFooter = await footerCheck(page, '[aria-label="Text studio"] .ts-assets', ".ts-stage", `${tag} Text studio`);
    await page.waitForTimeout(600);
    await page.screenshot({ path: join(outDir, `assets-${tag}-text-studio-assets.png`) });
    // A texture as the background: bottom of the layers, behind the photo (the photo stays: its pixel unchanged).
    const photoPixelBefore = await canvasPixel(page, 0.5, 0.1);
    await ts.locator(".ts-assets .fp-card", { hasText: "Concrete wall texture" }).click();
    await ts.locator(".ts-assets .fp-footer button", { hasText: "Set as background" }).click();
    await page.getByRole("button", { name: /^Download$/ }).click();
    await page.waitForTimeout(1200);
    const photoPixelAfter = await canvasPixel(page, 0.5, 0.1);
    r.photoPixel = { before: photoPixelBefore, after: photoPixelAfter };
    if (!near(photoPixelBefore, photoPixelAfter, 2)) errors.push(`${tag}: a background must stay behind the photo; the photo's pixel changed ${photoPixelBefore} → ${photoPixelAfter}`);
    // Make the photo smaller: the texture shows around it.
    const photoSize = ts.locator(".ts-mini", { hasText: "Frame the photo" });
    await photoSize.waitFor({ state: "visible", timeout: 5000 });
    await photoSize.click();
    await page.waitForTimeout(900);
    const corner = await canvasPixel(page, 0.02, 0.02);
    r.cornerAfterFrame = corner;
    if (!near(corner, [150, 150, 156], 12)) errors.push(`${tag}: with the photo at 80% the background texture should show in the corner, read ${corner}`);
    if (narrow) await ts.locator(".ts-tabs button", { hasText: "Layers" }).click();
    const rows = await ts.locator(".ts-layer .ts-layer-name").allInnerTexts();
    r.layersAfterBackground = rows;
    if (!/^Background/.test(rows[rows.length - 1] ?? "")) errors.push(`${tag}: the background should be the bottom row of the layers, read ${rows.join(", ")}`);
    r.bgBadge = await ts.locator(".ts-layer .ts-layer-bg").count();
    // Add text: a normal, editable text layer.
    if (!narrow) {
      await ts.locator(".ts-layers .ts-mini", { hasText: "Add" }).click();
      await page.locator(".ts-add-menu button", { hasText: "Text" }).first().click();
    } else {
      await page.locator(".ts-stage").click({ position: { x: 5, y: 5 } }).catch(() => undefined);
      await page.keyboard.press("t");
    }
    await page.waitForTimeout(500);
    const rowsAfterText = await ts.locator(".ts-layer .ts-layer-name").allInnerTexts();
    r.layersAfterText = rowsAfterText;
    if (rowsAfterText.length !== rows.length + 1) errors.push(`${tag}: adding text should add one layer (${rows.length} → ${rowsAfterText.length})`);
    r.downloads = calls.download.map((d) => `${d.id}${d.confirm ? " (confirmed)" : ""}`);
    r.uses = calls.use.map((u) => `${u.asset}:${u.role}`);
    if (calls.use.filter((u) => u.role === "design").length !== 2) errors.push(`${tag}: two design uses were expected (layer, background), saw ${JSON.stringify(r.uses)}`);
    await page.waitForTimeout(1500);
    await page.screenshot({ path: join(outDir, `assets-${tag}-text-studio.png`) });
    const sideways = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    if (sideways) errors.push(`${tag}: the page scrolls sideways.`);
  } catch (e) {
    errors.push(`${tag}: the flow stopped: ${e instanceof Error ? e.message : String(e)}`);
    await page.screenshot({ path: join(outDir, `assets-${tag}-failed.png`) }).catch(() => undefined);
  }
  await page.close();
}

await run({ width: 1440, height: 1000 }, "1440");
await run({ width: 390, height: 844 }, "390");

result.paidRoutes = calls.paid;
if (calls.paid.length) errors.push(`Layer and background work reached a paid route: ${calls.paid.join(", ")}`);
result.planSaves = calls.plan;
console.log(JSON.stringify(result, null, 2));
if (outside.length) errors.push(`Network calls outside the test server: ${[...new Set(outside)].join(", ")}`);
await browser.close();
served.server.close();
if (errors.length) {
  console.error("FAILED:\n- " + errors.join("\n- "));
  process.exit(1);
}
console.log(`OK · screenshots in ${outDir}`);
