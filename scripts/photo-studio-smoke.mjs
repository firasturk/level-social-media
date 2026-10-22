/**
 * A browser smoke test of the Photo studio in headless Chromium: the built app (dist/client, from
 * `npm run build`) is served statically with the studio's boot answered by a mock (a signed-in
 * admin, one client, one month with one post and its picture), the month opens, the card's "Edit
 * picture" opens the Photo studio, and the script checks that the studio mounts with its six
 * tools, that the Adjust panel changes the canvas pixels (exposure up: a brighter pixel), that the
 * crop frame appears, that an Apply posts the picture to the upload route, that the Presets panel
 * draws the fixture cards with their sample pictures and "Use this style" fills the AI tools'
 * Generate form, that the AI tools panel lists both providers' tools with the cost button, and that
 * the 390 px layout shows the bottom toolbar (seven tools: Presets and AI tools share one "AI"
 * button). Screenshots at 1440 and 390 land in --out (default: ./smoke).
 * No Worker, no D1, no wrangler and no provider are involved: the mock is in this file.
 *
 * Usage:  npm run build && node scripts/photo-studio-smoke.mjs [--out dir]
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

/** A real PNG: a mid-grey picture with a darker band, so an exposure change shows in a pixel. */
function png(w, h) {
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
    for (let x = 0; x < w; x++) {
      const band = y > h * 0.4 && y < h * 0.6;
      raw.set(band ? [70, 60, 50] : [120, 110, 100], y * (1 + w * 3) + 1 + x * 3);
    }
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

const NOW = Date.now();
const ADMIN = { id: "u1", email: "smoke@example.test", name: "Smoke", role: "admin" };
const CLIENT = { id: "c1", slug: "habibah", name: "Habibah", logo: false, badge: false, colors: [{ name: "Pistachio", hex: "#8fbf6a" }], fonts: {}, tone: "", dos: "", donts: "", style: "", gridRhythm: "", language: "en", status: "active", position: 0, batches: 1, updated: NOW, overlay: null, fontFiles: [], places: [] };
const POST = { index: 1, type: "offer", title: "Pistachio week", brief: "The pistachio kunafa on marble.", caption: "", hashtags: "", product: "pistachio", headline: "Pistachio week", subline: "This week only", ideaAt: 1 };
const CONFIG = { mode: "post", input: "model", prompt: "", ratio: "4:5", size: "1K", count: 1, backdrop: "", market: "auto", skill: "editorial", economy: false, output: "jpg", outputQuality: 90, outputSize: "fit", colors: "", modelDescription: "", center: true, client: "c1", month: "2026-10", postCount: 1, format: "4:5", model: "nano-banana-pro", plan: [POST], plannedAt: 1 };
const BATCH = { id: "b1", name: "Habibah · October 2026", config: JSON.stringify(CONFIG), client: "c1", month: "2026-10", theme: null, state: "idle", last_error: null, created: NOW, updated: NOW };
const TASK = { id: "t1", source: "s1", card: 1, status: "ready", output: "u1/b1/output/t1/a.png", qa: JSON.stringify({ automated: true, flags: [], notes: "Looks right.", found: true, count: 1, box: [], productConcern: false, centered: true }), error: null, prompt: "", attempts: 1, request_id: null, brief: null, cost: 0.04, updated: NOW, post: 1, made_for: 1 };
const SOURCE = { id: "s1", name: "pistachio.jpg", mime: "image/jpeg", size: 1000, role: "lead", kind: "product", created: NOW };
const RESULT_URL = `/api/studio/file?batch=b1&id=t1&kind=result&v=a.png`;

/** The Presets gallery's fixtures: the sample pictures are served by this server (hotlinked from the provider in the real app). */
const sample = (name) => `/samples/${name}.png`;
const STYLE_CARD = (id, title, description, prompt) => ({ id, source: "soul", provider: "higgsfield", kind: "style", title, description, command: null, category: null, type: "style", image: sample(id), price: null, needs: ["this post's picture", "a few words of prompt"], runnable: false, prompt, use: { provider: "higgsfield", tool: "hf-generate", options: { styleId: id, ...(prompt ? { prompt } : {}) } } });
const PRESET_CATEGORIES = [
  { id: "styles", label: "Styles", hint: "Higgsfield's Soul picture styles.", provider: "higgsfield" },
  { id: "product-shots", label: "Product shots", hint: "Higgsfield's product-shot presets.", provider: "higgsfield" },
  { id: "magnific-looks", label: "Magnific looks", hint: "Magnific's picture models and upscale presets.", provider: "magnific" },
  { id: "recipes", label: "Recipes", hint: "Step-by-step picture commands.", provider: "higgsfield" },
];
const PRESETS = {
  styles: [STYLE_CARD("soul_film", "Film grain", "Soft film colours and a little grain.", "film photograph, soft grain"), STYLE_CARD("soul_editorial", "Editorial", "Magazine light, clean shadows.", null)],
  "product-shots": [{ id: "hero_shot", source: "marketing_studio", provider: "higgsfield", kind: "preset", title: "Hero Shot", description: "The product on a marble pedestal, studio light.", command: "/hero-shot", category: "product-shot", type: "image", image: sample("hero"), price: 6, needs: ["1 product picture"], runnable: true, prompt: null, use: null }],
  "magnific-looks": [
    { id: "portrait", source: "magnific", provider: "magnific", kind: "look", title: "Portrait", description: "", command: null, category: "upscale preset", type: "upscale", image: sample("portrait"), price: null, needs: ["this post's picture"], runnable: false, prompt: null, use: { provider: "magnific", tool: "mg-upscale", options: { preset: "portrait" } } },
    { id: "product", source: "magnific", provider: "magnific", kind: "look", title: "Product", description: "", command: null, category: "upscale preset", type: "upscale", image: null, price: null, needs: ["this post's picture"], runnable: false, prompt: null, use: { provider: "magnific", tool: "mg-upscale", options: { preset: "product" } } },
  ],
  recipes: [{ id: "/hero-shot", source: "recipe", provider: "higgsfield", kind: "recipe", title: "Hero shot", description: "A product picture on a pedestal in one command.", command: "/hero-shot", category: "recipe", type: "recipe", image: null, price: null, needs: [], runnable: false, prompt: "hero shot of the product on a pedestal", use: { provider: "higgsfield", tool: "hf-generate", options: { prompt: "hero shot of the product on a pedestal" } } }],
};
const presetList = (category) => ({ ok: true, category, categories: PRESET_CATEGORIES, provider: category === "magnific-looks" ? "magnific" : "higgsfield", items: PRESETS[category] ?? [], cachedAt: NOW, cached: true, signedIn: true, admin: true, access: { admin: true, enabled: true, reason: "" }, reason: "", empty: "Nothing in this category on your plan yet." });
const presetDetail = (id) => {
  const card = Object.values(PRESETS).flat().find((c) => c.id === id) ?? PRESETS.styles[0];
  return { ok: true, preset: { ...card, inputSchema: card.kind === "preset" ? { type: "object", properties: { product_image: { type: "string", format: "media" }, prompt: { type: "string", description: "A few words on the mood" } }, required: ["product_image"] } : null, readiness: card.kind === "preset" ? { ready: true, missing: [] } : null, available: card.kind === "preset" ? true : null, instructions: card.kind === "style" ? "" : `How ${card.command ?? card.title} works: the product picture, a mood, one run.` }, readinessError: "", admin: true };
};
const available = (provider, on) => Object.fromEntries([["hf-upscale", "hf-remove-bg", "hf-outpaint", "hf-reframe", "hf-relight", "hf-generate"], ["mg-upscale", "mg-relight", "mg-remove-bg", "mg-replace-bg", "mg-retouch", "mg-skin", "mg-expand", "mg-restyle", "mg-reimagine", "mg-camera", "mg-variations"]][provider === "higgsfield" ? 0 : 1].map((id) => [id, on]));
const TOOL_CATALOG = {
  ok: true,
  admin: true,
  tools: [],
  higgsfield: { provider: "higgsfield", connected: true, enabled: true, admin: true, reason: "", balance: 1500, available: available("higgsfield", true) },
  magnific: { provider: "magnific", connected: true, enabled: true, admin: true, reason: "", balance: 320, available: available("magnific", true) },
  upscalePresets: [{ id: "portrait", label: "Portrait" }, { id: "product", label: "Product" }],
  upscaleModes: [{ id: "precision", label: "Precision" }],
  retouchModels: [{ id: "retouch-v2", label: "Retouch v2" }],
  cachedAt: NOW,
};

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".woff2": "font/woff2", ".json": "application/json", ".ico": "image/x-icon" };
const uploads = [];
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
  "/api/studio/photolab/status": { connected: false, provider: "demo", reason: "No Freepik key saved: every run is a demo.", prices: { "remove-bg": 0.02, background: 0.04, relight: 0.04, upscale: 0.06 }, approximate: true, access: { admin: true, enabled: true, reason: "" } },
  "/api/studio/photolab/jobs": { jobs: [] },
  "/api/studio/freepik/status": { connected: false, demo: true, reason: "No key", admin: true, access: "admin", plan: "unknown", planLabel: "", downloadEstimate: null, entitlements: {}, mcp: { connected: false, url: "" }, switch: { enabled: true, reason: "" } },
  "/api/studio/freepik/search": { items: [], page: 1, lastPage: 1, total: 0, demo: true, connected: false, downloadEstimate: null },
  "/api/studio/freepik/assets": { assets: [] },
  "/api/studio/drive/c1": { groups: { product: [], reference: [] }, photos: [], missing: [], demo: true },
  "/api/studio/ambassadors": { ambassadors: [] },
  "/api/studio/publish/status": { connected: false },
  "/api/studio/publish": { publications: [] },
  "/api/studio/ocr/status": { connected: false, provider: "none", reason: "Not connected" },
  "/api/studio/photo/tools/catalog": TOOL_CATALOG,
  "/api/studio/photo/tools/jobs": { ok: true, jobs: [] },
};

async function startStatic() {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const path = decodeURIComponent(url.pathname);
    if (path.startsWith("/samples/")) {
      res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" });
      res.end(PICTURE);
      return;
    }
    if (path.startsWith("/api/")) {
      if (path === "/api/studio/photo/presets") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(presetList(url.searchParams.get("category") ?? "styles")));
        return;
      }
      if (path.startsWith("/api/studio/photo/presets/")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(presetDetail(path.slice("/api/studio/photo/presets/".length))));
        return;
      }
      if (path === "/api/studio/posts/picture/upload") {
        let n = 0;
        req.on("data", (c) => (n += c.length));
        req.on("end", () => {
          uploads.push({ bytes: n, type: req.headers["content-type"] ?? "" });
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, task: "t1", key: "u1/b1/output/t1/b.png", previous: TASK.output }));
        });
        return;
      }
      if (path === "/api/studio/file") {
        res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" });
        res.end(PICTURE);
        return;
      }
      const body = MOCK[path] ?? (path.includes("/list") || path.endsWith("s") ? [] : {});
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
      return;
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
page.on("console", (m) => m.type() === "error" && !/favicon|404/.test(m.text()) && errors.push(`console error: ${m.text()}`));
const ALLOWED = [url, "data:", "blob:", "https://fonts.googleapis.com/", "https://fonts.gstatic.com/"];
page.on("request", (r) => {
  const u = r.url();
  if (!ALLOWED.some((a) => u.startsWith(a))) outside.push(u);
});
// The start journey is for a first visit; this browser has seen it.
await page.addInitScript(() => {
  try {
    sessionStorage.setItem("lsm-journey-done", "1");
    localStorage.setItem("lsm-journey-done", "1");
    localStorage.setItem("lsm-client", "c1");
  } catch {
    /* storage blocked */
  }
});

const result = {};
try {
  await page.goto(`${url}/?client=c1&month=2026-10`, { waitUntil: "networkidle" });
  const editPicture = page.getByRole("button", { name: /^Edit picture$/ }).first();
  await editPicture.waitFor({ state: "visible", timeout: 20000 });
  await editPicture.click();
  const studio = page.locator('[role="dialog"][aria-label="Photo studio"]');
  await studio.waitFor({ state: "visible", timeout: 20000 });
  result.mounted = true;
  result.title = (await studio.locator(".ts-title").innerText()).trim();
  const rail = studio.locator(".ps-rail button");
  result.railTools = await rail.allInnerTexts();
  if (result.railTools.length !== 8) errors.push(`The rail should show 8 tools, found ${result.railTools.length}: ${result.railTools.join(", ")}`);
  await studio.locator(".ps-picture").waitFor({ state: "visible", timeout: 10000 });
  result.editPanel = await studio.locator("#ps-instruction").count();
  if (!result.editPanel) errors.push("The Edit panel (the instruction box) should be open first.");
  await page.screenshot({ path: join(outDir, "photo-studio-1440-edit.png") });

  // Adjust: the canvas pixels change with exposure.
  await rail.filter({ hasText: "Adjust" }).click();
  const canvas = studio.locator(".ps-adjust-canvas");
  await canvas.waitFor({ state: "visible", timeout: 10000 });
  const readPixel = () =>
    page.evaluate(() => {
      const c = document.querySelector(".ps-adjust-canvas");
      const d = c.getContext("2d").getImageData(Math.floor(c.width / 2), Math.floor(c.height / 8), 1, 1).data;
      return [d[0], d[1], d[2], d[3]];
    });
  await page.waitForFunction(() => {
    const c = document.querySelector(".ps-adjust-canvas");
    return c && c.width > 1 && c.getContext("2d").getImageData(1, 1, 1, 1).data[3] > 0;
  });
  const before = await readPixel();
  const exposure = studio.locator('input[aria-label="Exposure"]');
  await exposure.evaluate((el) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(el, "60");
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.waitForFunction(
    (b) => {
      const c = document.querySelector(".ps-adjust-canvas");
      const d = c.getContext("2d").getImageData(Math.floor(c.width / 2), Math.floor(c.height / 8), 1, 1).data;
      return d[0] !== b[0];
    },
    before,
    { timeout: 5000 },
  ).catch(() => undefined);
  const after = await readPixel();
  result.pixelBefore = before;
  result.pixelAfterExposure = after;
  if (!(after[0] > before[0] && after[1] > before[1])) errors.push(`Exposure +60 should brighten the canvas pixel: before ${before}, after ${after}`);
  result.undoEnabled = await studio.locator('button[aria-label="Undo"]').isEnabled();
  if (!result.undoEnabled) errors.push("Undo should be enabled after a slider change.");
  // The crop frame.
  await studio.getByRole("button", { name: /^Crop$/ }).click();
  await studio.locator(".ps-crop").waitFor({ state: "visible", timeout: 5000 });
  result.cropHandles = await studio.locator(".ps-crop .ps-handle").count();
  if (result.cropHandles !== 8) errors.push(`The crop frame should have 8 handles, found ${result.cropHandles}`);
  await studio.getByRole("radio", { name: "4:5" }).click();
  await page.screenshot({ path: join(outDir, "photo-studio-1440-adjust.png") });
  // Apply: the confirm, then the upload route gets a multipart PNG.
  await studio.getByRole("button", { name: /Apply as the post's picture/ }).click();
  const confirm = page.getByRole("button", { name: /^Apply$/ });
  await confirm.waitFor({ state: "visible", timeout: 5000 });
  await confirm.click();
  await page.waitForFunction(() => !document.querySelector(".ps-adjust-canvas") || true);
  await page.waitForTimeout(1500);
  result.uploads = uploads;
  if (uploads.length !== 1) errors.push(`One upload was expected after Apply, saw ${uploads.length}`);
  else if (!/multipart\/form-data/.test(uploads[0].type) || uploads[0].bytes < 1000) errors.push(`The upload should be a multipart form with the picture: ${JSON.stringify(uploads[0])}`);
  result.adjustmentsClearedAfterApply = (await studio.locator(".ts-save.dirty").count()) === 0;
  if (!result.adjustmentsClearedAfterApply) errors.push("After Apply the 'Adjustments not applied' chip should be gone.");

  // Versions and Check panels mount.
  await rail.filter({ hasText: "Versions" }).click();
  await studio.locator(".ps-takes li").first().waitFor({ state: "visible", timeout: 5000 });
  result.takesListed = await studio.locator(".ps-takes li").count();
  await rail.filter({ hasText: "Check" }).click();
  result.reviewShown = (await studio.locator(".ps-review").count()) === 1;
  await rail.filter({ hasText: "Photo lab" }).click();
  result.labCards = await studio.locator(".ps-card").count();
  if (result.labCards !== 4) errors.push(`The Photo lab should show 4 tool cards, found ${result.labCards}`);
  result.labNote = (await studio.locator(".ps-lab-note").count()) === 1;
  if (!result.labNote) errors.push("The Photo lab should carry the note that Magnific's own tools are under AI tools.");

  // Presets: the gallery takes the stage, the fixture cards show their sample pictures, the categories are listed.
  await rail.filter({ hasText: "Presets" }).click();
  await studio.locator(".ps-gallery").waitFor({ state: "visible", timeout: 10000 });
  await studio.locator(".ps-preset").first().waitFor({ state: "visible", timeout: 10000 });
  result.presetCategories = await studio.locator(".ps-cats button").allInnerTexts();
  if (result.presetCategories.length !== 4) errors.push(`The Presets gallery should list 4 categories, found ${result.presetCategories.join(", ")}`);
  result.presetCards = await studio.locator(".ps-preset").count();
  if (result.presetCards !== 2) errors.push(`The Styles category should show 2 fixture cards, found ${result.presetCards}`);
  // The samples load lazily: give them a moment before reading whether each drew.
  await page.waitForFunction(() => [...document.querySelectorAll(".ps-preset-media img")].every((i) => i.complete && i.naturalWidth > 0), null, { timeout: 5000 }).catch(() => undefined);
  result.presetSamples = await studio.locator(".ps-preset-media img").evaluateAll((imgs) => imgs.map((i) => ({ src: i.getAttribute("src"), loaded: i.complete && i.naturalWidth > 0 })));
  if (result.presetSamples.length !== 2 || !result.presetSamples.every((s) => s.src?.includes("/samples/") && s.loaded)) errors.push(`Every card should show its sample <img>: ${JSON.stringify(result.presetSamples)}`);
  await studio.locator(".ps-cats button", { hasText: "Magnific looks" }).click();
  await studio.locator(".ps-preset-blank").first().waitFor({ state: "visible", timeout: 5000 });
  result.noSampleTile = (await studio.locator(".ps-preset-blank").innerText()).trim();
  if (!/No sample from Magnific/.test(result.noSampleTile)) errors.push(`A look with no sample should say so, read: ${result.noSampleTile}`);
  await studio.locator(".ps-cats button", { hasText: "Styles" }).click();
  await studio.locator(".ps-preset").first().waitFor({ state: "visible", timeout: 5000 });
  await page.screenshot({ path: join(outDir, "photo-studio-1440-presets.png") });
  // "Use this style" opens AI tools with the Generate form prefilled.
  await studio.locator(".ps-preset").first().getByRole("button", { name: /Use this style/ }).click();
  const styleSelect = studio.locator('select[data-option="styleId"]');
  await styleSelect.waitFor({ state: "visible", timeout: 5000 });
  result.prefilledStyle = await styleSelect.inputValue();
  result.prefilledPrompt = await studio.locator('textarea[data-option="prompt"]').inputValue();
  if (result.prefilledStyle !== "soul_film") errors.push(`"Use this style" should pick the style in the Generate form, found "${result.prefilledStyle}"`);
  if (!/film photograph/.test(result.prefilledPrompt)) errors.push(`"Use this style" should fill the prompt with the style's words, found "${result.prefilledPrompt}"`);
  result.aiToolsOpen = (await rail.filter({ hasText: "AI tools" }).getAttribute("aria-pressed")) === "true";
  if (!result.aiToolsOpen) errors.push("The AI tools panel should be the open one after 'Use this style'.");
  // The AI tools panel: both providers, their tools, the cost button.
  const providerTabs = studio.locator('[aria-label="Provider"] [role="tab"]');
  result.providers = await providerTabs.allInnerTexts();
  if (!/Higgsfield/.test(result.providers.join(" ")) || !/Magnific/.test(result.providers.join(" "))) errors.push(`The AI tools should list both providers, found ${result.providers.join(", ")}`);
  result.higgsfieldTools = await studio.locator(".ps-tool-cards .ps-card").count();
  if (result.higgsfieldTools !== 6) errors.push(`Higgsfield should list 6 tools, found ${result.higgsfieldTools}`);
  result.costButton = (await studio.getByRole("button", { name: /Get the cost/ }).count()) === 1;
  if (!result.costButton) errors.push("The AI tools panel should show the 'Get the cost' button.");
  await page.screenshot({ path: join(outDir, "photo-studio-1440-tools.png") });
  await providerTabs.filter({ hasText: "Magnific" }).click();
  await page.waitForTimeout(200);
  result.magnificTools = await studio.locator(".ps-tool-cards .ps-card").count();
  if (result.magnificTools !== 11) errors.push(`Magnific should list 11 tools, found ${result.magnificTools}`);
  result.magnificPresetChoices = await studio.locator('select[data-option="preset"] option').count();
  if (result.magnificPresetChoices !== 3) errors.push(`The Magnific upscale should offer the two presets from the catalog (plus the default), found ${result.magnificPresetChoices}`);

  // 390 px: one panel at a time, the bottom toolbar with Presets and AI tools under one "AI" button.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(500);
  result.bottomTabs = await studio.locator(".ps-bottom button").allInnerTexts();
  if (result.bottomTabs.length !== 7) errors.push(`The 390 px bottom toolbar should show 7 tools, found ${result.bottomTabs.length}: ${result.bottomTabs.join(", ")}`);
  result.railHiddenNarrow = (await studio.locator(".ps-rail").count()) === 0;
  result.bottomOverflow = await page.evaluate(() => {
    const bar = document.querySelector(".ps-bottom");
    return bar ? bar.scrollWidth - bar.clientWidth : -1;
  });
  if (result.bottomOverflow > 0) errors.push(`The bottom toolbar overflows by ${result.bottomOverflow} px at 390 px.`);
  result.aiOnNarrow = (await studio.locator(".ps-bottom button", { hasText: /^AI$/ }).getAttribute("class"))?.includes("on");
  if (!result.aiOnNarrow) errors.push("The 'AI' bottom button should be on while the AI tools panel is open.");
  await page.screenshot({ path: join(outDir, "photo-studio-390-tools.png") });
  await studio.locator(".ps-bottom button", { hasText: "Edit" }).click();
  await studio.locator("#ps-instruction").waitFor({ state: "visible", timeout: 5000 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  if (overflow) errors.push("The page scrolls sideways at 390 px.");
  await page.screenshot({ path: join(outDir, "photo-studio-390.png") });
  // The presets gallery on a phone: the categories in a row, two cards across.
  await studio.locator(".ps-bottom button", { hasText: /^AI$/ }).click();
  await studio.locator('[role="tablist"][aria-label="Presets or AI tools"] [role="tab"]', { hasText: "Presets" }).click();
  await studio.locator(".ps-gallery").waitFor({ state: "visible", timeout: 5000 });
  await studio.locator(".ps-preset").first().waitFor({ state: "visible", timeout: 5000 });
  const galleryOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  if (galleryOverflow) errors.push("The page scrolls sideways at 390 px with the Presets gallery open.");
  await page.screenshot({ path: join(outDir, "photo-studio-390-presets.png") });
} catch (e) {
  errors.push(`The flow stopped: ${e instanceof Error ? e.message : String(e)}`);
  await page.screenshot({ path: join(outDir, "photo-studio-failed.png") }).catch(() => undefined);
}

console.log(JSON.stringify(result, null, 2));
if (outside.length) errors.push(`Network calls outside the test server: ${[...new Set(outside)].join(", ")}`);
await browser.close();
served.server.close();
if (errors.length) {
  console.error("FAILED:\n- " + errors.join("\n- "));
  process.exit(1);
}
console.log(`OK · screenshots in ${outDir}`);
