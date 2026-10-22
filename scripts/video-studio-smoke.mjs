/**
 * A browser smoke test of the Video studio in headless Chromium: the built app (dist/client, from
 * `npm run build`) is served statically with the studio's boot answered by a mock (a signed-in
 * admin, one client, one month with one post and its picture, no clip yet) and the studio's own
 * routes answered from fixtures shaped like the server's answers (a preset gallery whose reference
 * videos are served by this script). The month opens, the card's clapperboard opens the Video
 * studio, and the script checks that the studio mounts with its seven tools, that it opens on the
 * Presets panel for a post with no clip, that the gallery renders the category list and the cards
 * with `<video muted loop playsinline>` elements, that the search filters the cards, that "Use this
 * preset" opens Generate with the preset's words, that Versions and Edit mount, and that the 390 px
 * layout shows the bottom toolbar with no sideways scroll. Screenshots at 1440 and 390 land in
 * --out (default: ./smoke). No Worker, no D1, no wrangler and no provider are involved.
 *
 * Usage:  npm run build && node scripts/video-studio-smoke.mjs [--out dir]
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
const SAMPLE_MP4 = await readFile(join(process.cwd(), "tests", "fixtures", "sample-1s.mp4"));

/** A real PNG: a mid-grey picture with a darker band. */
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

const CATEGORIES = [
  { id: "popular", label: "Popular", hint: "What Higgsfield shows first." },
  { id: "paid-ads", label: "Paid Ads", hint: "Presets written for ads." },
  { id: "motion", label: "Motion Design", hint: "Moving graphics." },
  { id: "marketing", label: "Marketing", hint: "Product shots and ad formats." },
  { id: "production", label: "Production", hint: "Katana productions." },
  { id: "ugc", label: "UGC", hint: "Creator-style clips." },
  { id: "faceless", label: "Faceless", hint: "No presenter." },
  { id: "effects", label: "Effects", hint: "Viral effects." },
  { id: "genjutsu", label: "Genjutsu", hint: "Motion transfers." },
  { id: "recipes", label: "Recipes", hint: "Step-by-step commands." },
];
/** Cards as server/video-presets.ts answers them; the reference videos point at this server. */
const presetCard = (url, id, title, extra = {}) => ({ id, source: "marketing_studio", title, description: `${title}: a short description of what the preset does to the picture.`, command: `/${id.replace(/_/g, "-")}`, category: "product-shot", type: "product", video: `${url}/fixtures/${id}.mp4`, poster: `${url}/fixtures/${id}.png`, price: 20, needs: ["1 product picture"], runnable: true, engine: null, prompt: `A ${title.toLowerCase()} of the product, slow and warm`, ...extra });

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".woff2": "font/woff2", ".json": "application/json", ".ico": "image/x-icon" };

async function startStatic() {
  let base = "";
  const server = createServer(async (req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    const path = decodeURIComponent(u.pathname);
    if (path.startsWith("/fixtures/")) {
      const mp4 = path.endsWith(".mp4");
      res.writeHead(200, { "content-type": mp4 ? "video/mp4" : "image/png", "accept-ranges": "bytes", "cache-control": "no-store" });
      res.end(mp4 ? SAMPLE_MP4 : PICTURE);
      return;
    }
    if (path.startsWith("/api/")) {
      if (path === "/api/studio/file") {
        res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" });
        res.end(PICTURE);
        return;
      }
      const presets = [presetCard(base, "hero_shot", "Hero Shot"), presetCard(base, "glitch_pop", "Glitch Pop", { source: "viral", category: "viral", type: "effect", price: null, needs: ["2 pictures"] }), presetCard(base, "turntable", "Turntable"), presetCard(base, "launch_day", "Launch day", { source: "katana", category: null, runnable: false, command: "/katana/launch-day", price: null })];
      const MOCK = {
        "/api/auth/me": { user: ADMIN, registrationOpen: false },
        "/api/studio/state": { user: ADMIN, batches: [BATCH], trash: [], spend: [], spendThreshold: 20, clients: [CLIENT], engine: { model: "nano-banana-pro", configured: false, source: "none", openai: "none", google: "none", fal: "none", review: false, vertex: null }, preview: true, workflowV2: true },
        "/api/studio/batch": { batch: BATCH, sources: [SOURCE], tasks: [TASK] },
        "/api/studio/engine/models": { models: [] },
        "/api/studio/styles/pending": { n: 0 },
        "/api/studio/lessons/pending": { n: 0 },
        "/api/studio/posts/themes": { themes: [] },
        "/api/studio/posts/takes": { takes: [] },
        "/api/studio/posts/versions": { versions: [] },
        "/api/studio/posts/video/summary": { posts: {} },
        "/api/studio/posts/video/list": { videos: [], engines: [], prices: {}, admin: true, access: { admin: true, enabled: true, reason: "" }, billing: "credits" },
        "/api/studio/posts/video/editor/projects": { projects: [], access: { admin: true, enabled: true, reason: "" } },
        "/api/studio/posts/video/audio/list": { tracks: [], access: { admin: true, enabled: true, reason: "" }, generated: { connected: false, reason: "Not connected" } },
        "/api/studio/posts/video/idea": { idea: "The steam rises and the kunafa turns slowly on the marble." },
        "/api/studio/higgsfield/mcp/status": { signedIn: true, email: "owner@test", signedInAt: NOW, plan: "Creator", credits: 1500, creditsAt: NOW, balanceError: "", billing: "credits", billingChosen: true, cloudConfigured: false, admin: true, switch: { enabled: true }, access: { admin: true, enabled: true, reason: "" }, url: "https://mcp.higgsfield.ai/mcp", device: null },
        "/api/studio/higgsfield/mcp/models": { models: [{ id: "seedance_2_5", name: "Seedance 2.5", description: "Natural motion", durations: [5, 10], aspects: ["9:16", "1:1"], supportsUnlim: false }, { id: "kling3_0", name: "Kling 3.0", description: "Cinematic", durations: [5, 10], aspects: [], supportsUnlim: true }], at: NOW },
        "/api/studio/video/presets": { ok: true, category: u.searchParams.get("category") ?? "popular", categories: CATEGORIES, items: u.searchParams.get("category") === "genjutsu" ? [] : presets, nextCursor: null, cachedAt: NOW, cached: true, signedIn: true, admin: true, access: { admin: true, enabled: true, reason: "" }, billing: "credits", reason: "", empty: "Nothing in this category on your plan yet." },
        "/api/studio/video/presets/hero_shot": { ok: true, preset: { ...presets[0], inputSchema: { type: "object", properties: { product_image: { type: "string", format: "media" }, prompt: { type: "string", description: "A few words on the mood" } }, required: ["product_image"] }, readiness: { ready: true, missing: [] }, available: true, instructions: "How /hero-shot works: upload the product picture, pick the mood, run." }, readinessError: "", admin: true },
        "/api/studio/video/magnific/status": { ok: true, connected: false, source: null, admin: true, access: { admin: true, enabled: true, reason: "" }, tools: [{ name: "video_upscale", label: "Upscale", hint: "A sharper clip." }, { name: "video_hdr", label: "HDR", hint: "More range." }], reason: "Not connected: sign in to Magnific under Connection → Freepik → Magnific MCP." },
        "/api/studio/video/higgsfield/tools": { ok: true, signedIn: true, billing: "credits", admin: true, access: { admin: true, enabled: true, reason: "" }, reason: "", available: { upscale_video: true, reframe: true, remove_background: false, virality_predictor: true, video_analysis_create: false, video_analysis_status: false }, tools: [{ name: "upscale_video", label: "Upscale", hint: "Sharper.", available: true }, { name: "reframe", label: "Reframe", hint: "Another frame.", available: true }, { name: "remove_background", label: "Remove the background", hint: "", available: false }], checks: [{ name: "virality_predictor", label: "Virality check", hint: "How the clip may perform.", available: true }, { name: "video_analysis_create", label: "Video analysis", hint: "", available: false }] },
        "/api/studio/photolab/status": { connected: false, provider: "demo", reason: "No key", prices: {}, approximate: true, access: { admin: true, enabled: true, reason: "" } },
        "/api/studio/freepik/status": { connected: false, demo: true, reason: "No key", admin: true, access: "admin", plan: "unknown", planLabel: "", downloadEstimate: null, entitlements: {}, mcp: { connected: false, url: "" }, switch: { enabled: true, reason: "" } },
        "/api/studio/drive/c1": { groups: { product: [], reference: [] }, photos: [], missing: [], demo: true },
        "/api/studio/ambassadors": { ambassadors: [] },
        "/api/studio/publish/status": { connected: false },
        "/api/studio/publish": { publications: [] },
        "/api/studio/ocr/status": { connected: false, provider: "none", reason: "Not connected" },
      };
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
  base = `http://127.0.0.1:${server.address().port}`;
  return { server, url: base };
}

const served = await startStatic();
const url = served.url;
const browser = await chromium.launch({ executablePath, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
const outside = [];
page.on("pageerror", (e) => errors.push(`page error: ${String(e)}`));
page.on("console", (m) => m.type() === "error" && !/favicon|404|media resource|Failed to load resource/.test(m.text()) && errors.push(`console error: ${m.text()}`));
const ALLOWED = [url, "data:", "blob:", "https://fonts.googleapis.com/", "https://fonts.gstatic.com/"];
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

const result = {};
try {
  await page.goto(`${url}/?client=c1&month=2026-10`, { waitUntil: "networkidle" });
  const open = page.getByRole("button", { name: /^Video studio$/ }).first();
  await open.waitFor({ state: "visible", timeout: 20000 });
  await open.click();
  const studio = page.locator('[role="dialog"][aria-label="Video studio"]');
  await studio.waitFor({ state: "visible", timeout: 20000 });
  result.mounted = true;
  result.title = (await studio.locator(".ts-title").innerText()).trim();
  const rail = studio.locator(".vs-rail button");
  result.railTools = await rail.allInnerTexts();
  if (result.railTools.length !== 7) errors.push(`The rail should show 7 tools, found ${result.railTools.length}: ${result.railTools.join(", ")}`);

  // A post with no clip opens on Presets: the category list and the cards with their reference videos.
  const gallery = studio.locator(".vs-gallery");
  await gallery.waitFor({ state: "visible", timeout: 20000 });
  await studio.locator(".vs-preset").first().waitFor({ state: "visible", timeout: 20000 });
  result.categories = await studio.locator(".vs-cats button").count();
  if (result.categories !== 10) errors.push(`The category list should show 10 categories, found ${result.categories}`);
  result.cards = await studio.locator(".vs-preset").count();
  if (result.cards !== 4) errors.push(`The gallery should show 4 fixture cards, found ${result.cards}`);
  // React sets `muted` as a property, not an attribute, so the three are read from the elements.
  result.videos = await studio.locator(".vs-preset video").evaluateAll((els) => els.filter((v) => v.muted && v.loop && v.playsInline && v.hasAttribute("playsinline")).length);
  if (result.videos !== 4) errors.push(`Every card should carry a muted, looping, inline video, found ${result.videos}`);
  result.commandChips = await studio.locator(".vs-preset .vs-chip.cmd").allInnerTexts();
  result.needs = await studio.locator(".vs-preset .vs-needs").first().innerText();
  // Hover plays the reference (muted).
  await studio.locator(".vs-preset").first().hover();
  await page.waitForTimeout(600);
  result.playsOnHover = await studio.locator(".vs-preset video").first().evaluate((v) => !v.paused || v.readyState > 0);
  await page.screenshot({ path: join(outDir, "video-studio-1440-presets.png") });
  // The search filters the cards.
  await studio.locator(".vs-search input").fill("glitch");
  await page.waitForTimeout(200);
  result.afterSearch = await studio.locator(".vs-preset").count();
  if (result.afterSearch !== 1) errors.push(`Searching "glitch" should leave 1 card, found ${result.afterSearch}`);
  await studio.locator(".vs-search input").fill("");
  // An empty category says so.
  await studio.locator(".vs-cats button", { hasText: "Genjutsu" }).click();
  await studio.locator(".vs-note", { hasText: /Nothing in this category/ }).waitFor({ state: "visible", timeout: 10000 });
  result.emptyCategoryNote = true;
  await studio.locator(".vs-cats button", { hasText: "Popular" }).click();
  await studio.locator(".vs-preset").first().waitFor({ state: "visible", timeout: 10000 });
  // Learn more opens the detail in the side panel with the video large and the run button.
  await studio.locator(".vs-preset").first().getByRole("button", { name: /Learn more/ }).click();
  await studio.locator(".vs-detail").waitFor({ state: "visible", timeout: 10000 });
  await studio.locator(".vs-detail").getByRole("button", { name: /Run this preset/ }).waitFor({ state: "visible", timeout: 10000 });
  result.detailTitle = (await studio.locator(".vs-detail-title").innerText()).trim();
  result.detailVideo = (await studio.locator(".vs-detail-media video").count()) === 1;
  await studio.locator(".vs-detail").getByRole("button", { name: /^Learn more$/ }).click();
  result.instructionsShown = (await studio.locator(".vs-detail .vs-words").count()) === 1;
  await page.screenshot({ path: join(outDir, "video-studio-1440-preset-detail.png") });
  // Use this preset: Generate opens prefilled.
  await studio.locator(".vs-detail").getByRole("button", { name: /Use this preset/ }).click();
  const idea = studio.locator("#vs-idea");
  await idea.waitFor({ state: "visible", timeout: 10000 });
  result.generateIdea = await idea.inputValue();
  if (!/hero shot/i.test(result.generateIdea)) errors.push(`Generate should be prefilled with the preset's words, got "${result.generateIdea}"`);
  result.fromPresetNote = (await studio.locator(".vs-from-preset").count()) === 1;
  await studio.locator(".vs-engine", { hasText: "Seedance 2.5" }).waitFor({ state: "visible", timeout: 10000 });
  result.engineChips = await studio.locator(".vs-engine").count();
  result.getCost = (await studio.getByRole("button", { name: /Get the cost/ }).count()) === 1;
  await page.screenshot({ path: join(outDir, "video-studio-1440-generate.png") });
  // Versions, Enhance, Check and Edit mount.
  await rail.filter({ hasText: "Versions" }).click();
  await studio.locator(".vs-list li").first().waitFor({ state: "visible", timeout: 10000 });
  result.versionsRows = await studio.locator(".vs-list li").count();
  await rail.filter({ hasText: "Enhance" }).click();
  await studio.locator(".vs-card").first().waitFor({ state: "visible", timeout: 10000 });
  result.enhanceCards = await studio.locator(".vs-card").count();
  await rail.filter({ hasText: "Check" }).click();
  await studio.locator(".vs-card").first().waitFor({ state: "visible", timeout: 10000 });
  result.checkNotAvailable = (await studio.locator(".vs-card.off").count()) >= 1;
  await rail.filter({ hasText: "Edit" }).click();
  await studio.locator(".ve-canvas").waitFor({ state: "visible", timeout: 10000 });
  result.editTabs = await studio.locator(".vs-tabs button").count();
  if (result.editTabs !== 5) errors.push(`The Edit panel should show its 5 tabs, found ${result.editTabs}`);
  await page.screenshot({ path: join(outDir, "video-studio-1440-edit.png") });

  // 390 px: one panel at a time, the bottom toolbar with the seven tools, no sideways scroll.
  await rail.filter({ hasText: "Presets" }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(500);
  result.bottomTabs = await studio.locator(".vs-bottom button").count();
  if (result.bottomTabs !== 7) errors.push(`The 390 px bottom toolbar should show 7 tools, found ${result.bottomTabs}`);
  result.railHiddenNarrow = (await studio.locator(".vs-rail").count()) === 0;
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  if (overflow) errors.push("The page scrolls sideways at 390 px.");
  await page.screenshot({ path: join(outDir, "video-studio-390-presets.png") });
  await studio.locator(".vs-bottom button", { hasText: "Generate" }).click();
  await studio.locator("#vs-idea").waitFor({ state: "visible", timeout: 5000 });
  await page.screenshot({ path: join(outDir, "video-studio-390-generate.png") });
} catch (e) {
  errors.push(`The flow stopped: ${e instanceof Error ? e.message : String(e)}`);
  await page.screenshot({ path: join(outDir, "video-studio-failed.png") }).catch(() => undefined);
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
