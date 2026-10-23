/**
 * Edit quality in the real studio UI (docs/video-editor.md → Edit quality), in Google Chrome (it
 * decodes the H.264 footage): the built app (dist/client) served with a stateful mock of the
 * studio's routes, one post whose versions are the footage given with --footage. It checks:
 *   - Auto edit: "Build the cut" fills the timeline and the panel says what it did (the summary);
 *   - Edit like this video: a Pinterest link the mock refuses shows the plain message with the
 *     alternatives; an uploaded reference (--reference, an MP4) is read, its facts listed; "Apply to
 *     my footage" cuts the timeline on its shots; "Compare the two videos" opens the side-by-side view
 *     with the timing table, plays, and is screenshotted at 1440 and 390 px (no sideways scroll);
 *   - Save draft stores version 4 with the reference's analysis and the summary (not the footage);
 *     after a reload and reopen the summary, the analysis and the table are back, and the comparison
 *     asks to pick the reference again (an upload stays in its tab).
 * Usage: npm run build && node scripts/video-edit-quality-smoke.mjs --footage <dir> --reference <mp4> --chrome <path> [--out dir]
 */
import { createServer } from "node:http";
import { execSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { mkdir, readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { pathToFileURL } from "node:url";

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
const arg = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const outDir = arg("--out", join(process.cwd(), "smoke"));
const footage = arg("--footage", null);
const reference = arg("--reference", null);
const chromePath = arg("--chrome", process.env.CHROME_PATH || "/opt/pw-browsers/chromium");
if (!footage || !reference) throw new Error("--footage <dir> and --reference <mp4> are required");
await mkdir(outDir, { recursive: true });
const root = process.cwd();
const dist = join(root, "dist", "client");
const files = readdirSync(footage).filter((f) => f.endsWith(".mp4")).sort();
const PICTURE = readFileSync(join(root, "public", "guide", "product.jpg"));

const NOW = Date.now();
const ADMIN = { id: "u1", email: "smoke@example.test", name: "Smoke", role: "admin" };
const CLIENT = { id: "c1", slug: "habibah", name: "Habibah", logo: false, badge: false, colors: [], fonts: {}, tone: "", dos: "", donts: "", style: "", gridRhythm: "", language: "en", status: "active", position: 0, batches: 1, updated: NOW, overlay: null, fontFiles: [], places: [] };
const POST = { index: 1, type: "offer", title: "Spring drop", brief: "A launch reel.", caption: "", hashtags: "", product: "", headline: "New drop", subline: "", ideaAt: 1 };
const CONFIG = { mode: "post", input: "model", prompt: "", ratio: "4:5", size: "1K", count: 1, backdrop: "", market: "auto", skill: "editorial", economy: false, output: "jpg", outputQuality: 90, outputSize: "fit", colors: "", modelDescription: "", center: true, client: "c1", month: "2026-10", postCount: 1, format: "4:5", model: "nano-banana-pro", plan: [POST], plannedAt: 1 };
const BATCH = { id: "b1", name: "Habibah · October 2026", config: JSON.stringify(CONFIG), client: "c1", month: "2026-10", theme: null, state: "idle", last_error: null, created: NOW, updated: NOW };
const TASK = { id: "t1", source: "s1", card: 1, status: "ready", output: "u1/b1/output/t1/a.jpg", qa: JSON.stringify({ automated: true, flags: [], notes: "", found: true, count: 1, box: [], productConcern: false, centered: true }), error: null, prompt: "", attempts: 1, request_id: null, brief: null, cost: 0, updated: NOW, post: 1, made_for: 1 };
const SOURCE = { id: "s1", name: "p.jpg", mime: "image/jpeg", size: 1000, role: "lead", kind: "product", created: NOW };
const ACCESS = { admin: true, enabled: true, reason: "" };
const item = (id, n, extra = {}) => ({ id, post: 1, model: "upload", provider: "upload", source: "upload", prompt: files[n - 1].replace(/\.mp4$/, ""), status: "done", error: null, created: NOW + n, updated: NOW + n, duration: 7, aspect: null, resolution: null, estimate: null, forClient: false, requestId: null, url: `/api/studio/posts/video/file?batch=b1&id=${id}`, poster: null, preview: null, version: n, warnings: [], audioChoice: null, audioId: null, audioName: null, label: files[n - 1].replace(/\.mp4$/, ""), check: null, analysis: null, frame: "16:9", frameFill: null, words: null, width: 1920, height: 1080, project: null, ...extra });
const state = { videos: files.map((_, i) => item(`v${i + 1}`, i + 1, i === 0 ? { forClient: true } : {})), projects: new Map(), saves: [], pinterestAsks: 0 };
const projectItem = (p) => ({ id: p.id, batch: "b1", post: 1, name: p.doc.name, rev: p.rev, sourceVideo: "v1", renderedVideo: null, created: NOW, updated: Date.now(), createdBy: "u1", updatedBy: "u1", clips: p.doc.clips.length });

async function body(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

/** A file with Range, as the studio's version route serves it. */
function ranged(req, res, type, file) {
  const size = statSync(file).size;
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
  const data = readFileSync(file);
  if (!m) {
    res.writeHead(200, { "content-type": type, "accept-ranges": "bytes", "content-length": size });
    return res.end(data);
  }
  const start = m[1] === "" ? size - Number(m[2]) : Number(m[1]);
  const end = m[2] === "" || m[1] === "" ? size - 1 : Math.min(size - 1, Number(m[2]));
  res.writeHead(206, { "content-type": type, "accept-ranges": "bytes", "content-length": end - start + 1, "content-range": `bytes ${start}-${end}/${size}` });
  res.end(data.subarray(start, end + 1));
}

async function api(req, res, path, u) {
  const send = (status, b) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(b));
  };
  const ED = "/api/studio/posts/video/editor";
  if (path === "/api/studio/posts/video/file") {
    const n = Number((u.searchParams.get("id") ?? "v1").slice(1));
    return ranged(req, res, "video/mp4", join(footage, files[n - 1]));
  }
  if (path === "/api/studio/file") {
    res.writeHead(200, { "content-type": "image/jpeg" });
    return res.end(PICTURE);
  }
  if (path === `${ED}/reference` && req.method === "POST") {
    // Pinterest refuses the studio here, as it did from this sandbox: the route answers what the server says then.
    state.pinterestAsks++;
    return send(502, { error: "Pinterest did not hand this pin's video to the studio (it often refuses servers). Save the video from Pinterest and use Upload, or pick the clip from the client's Drive: the analysis is the same." });
  }
  if (path === "/api/studio/posts/video/list") return send(200, { videos: state.videos, engines: [], prices: {}, admin: true, access: ACCESS, billing: "credits" });
  if (path === "/api/studio/posts/video/summary") return send(200, { posts: { 1: { latest: state.videos[0], client: state.videos[0], done: state.videos[0], card: null } } });
  if (path === `${ED}/projects` && req.method === "GET") return send(200, { projects: [...state.projects.values()].map(projectItem), access: ACCESS });
  if (path === `${ED}/projects` && req.method === "POST") {
    const d = JSON.parse(await body(req));
    const p = { id: "p1", rev: 1, doc: { ...d.project, rev: 1 } };
    state.projects.set(p.id, p);
    state.saves.push(p.doc);
    return send(200, { project: projectItem(p), document: p.doc });
  }
  const pm = /^\/api\/studio\/posts\/video\/editor\/projects\/([^/]+)$/.exec(path);
  if (pm) {
    const p = state.projects.get(pm[1]);
    if (!p) return send(404, { error: "Project not found." });
    if (req.method === "PUT") {
      const d = JSON.parse(await body(req));
      p.rev += 1;
      p.doc = { ...d.project, rev: p.rev };
      state.saves.push(p.doc);
    }
    return send(200, { project: projectItem(p), document: p.doc, access: ACCESS });
  }
  if (path === `${ED}/renders`) return send(200, { renders: [] });
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
    "/api/studio/posts/video/audio/list": { tracks: [], access: ACCESS, generated: { connected: false, reason: "Not connected" } },
    "/api/studio/publish/status": { connected: false },
    "/api/studio/publish": { publications: [] },
    "/api/studio/higgsfield/mcp/status": { signedIn: false, email: null, signedInAt: null, plan: null, credits: null, creditsAt: null, balanceError: "", billing: "credits", billingChosen: true, cloudConfigured: false, admin: true, switch: { enabled: true }, access: ACCESS, url: "", device: null },
    "/api/studio/higgsfield/mcp/models": { models: [], at: NOW },
    "/api/studio/video/presets": { ok: true, category: "popular", categories: [], items: [], nextCursor: null, cachedAt: NOW, cached: true, signedIn: false, admin: true, access: ACCESS, billing: "credits", reason: "", empty: "Nothing here." },
    "/api/studio/video/magnific/status": { ok: true, connected: false, source: null, admin: true, access: ACCESS, tools: [], reason: "Not connected" },
    "/api/studio/video/higgsfield/tools": { ok: true, signedIn: false, billing: "credits", admin: true, access: ACCESS, reason: "", available: {}, tools: [], checks: [] },
    "/api/studio/photolab/status": { connected: false, provider: "demo", reason: "No key", prices: {}, approximate: true, access: ACCESS },
    "/api/studio/freepik/status": { connected: false, demo: true, reason: "No key", admin: true, access: "admin", plan: "unknown", planLabel: "", downloadEstimate: null, entitlements: {}, mcp: { connected: false, url: "" }, switch: { enabled: true, reason: "" } },
    "/api/studio/drive/c1": { groups: { product: [], reference: [], brand: [], output: [] }, photos: [], missing: [], demo: true },
    "/api/studio/ambassadors": { ambassadors: [] },
    "/api/studio/ocr/status": { connected: false, provider: "none", reason: "Not connected" },
    "/api/studio/music/catalog": { tracks: [], total: 0, moods: [], genres: [], access: ACCESS },
    "/api/studio/music/library": { tracks: [], total: 0, moods: [], genres: [], access: ACCESS },
  };
  const b = MOCK[path] ?? (path.includes("/list") || path.endsWith("s") ? [] : {});
  return send(200, b);
}

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".woff2": "font/woff2", ".json": "application/json", ".ico": "image/x-icon" };
const server = createServer(async (req, res) => {
  const u = new URL(req.url ?? "/", "http://x");
  const path = decodeURIComponent(u.pathname);
  if (path.startsWith("/api/")) {
    try {
      await api(req, res, path, u);
    } catch (e) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: String(e) }));
    }
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
  res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
  res.end(await readFile(file));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({ executablePath: chromePath, headless: true, args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.setDefaultTimeout(120000);
const errors = [];
const outside = [];
page.on("pageerror", (e) => errors.push(`page error: ${String(e)}`));
const ALLOWED = [url, "data:", "blob:", "https://fonts.googleapis.com/", "https://fonts.gstatic.com/"];
page.on("request", (r) => {
  if (!ALLOWED.some((a) => r.url().startsWith(a))) outside.push(r.url());
});
await page.addInitScript(() => {
  try {
    sessionStorage.setItem("lsm-journey-done", "1");
    localStorage.setItem("lsm-journey-done", "1");
    localStorage.setItem("lsm-client", "c1");
    // Chrome has no AAC encoder: the test codecs keep the stage free of the stop message (nothing is rendered here).
    localStorage.setItem("lsm-video-test-codecs", "vp9");
  } catch {
    /* storage blocked */
  }
});

const result = {};
const studio = page.locator('[role="dialog"][aria-label="Video studio"]');
async function openFromCard() {
  const edit = page.locator(".pc-video-edit").first();
  await edit.waitFor({ state: "visible", timeout: 30000 });
  await edit.click();
  await studio.waitFor({ state: "visible", timeout: 30000 });
  await studio.locator(".ve-framebar").waitFor({ state: "visible", timeout: 30000 });
  await studio.locator(".ve-stage-msg").waitFor({ state: "detached", timeout: 60000 }).catch(() => undefined);
}
const tab = (name) => studio.locator(".vs-tabs button", { hasText: name }).click();
const noSideScroll = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
const compare = page.locator('[role="dialog"][aria-label="Compare the reference and your cut"]');

try {
  await page.goto(`${url}/?client=c1&month=2026-10`, { waitUntil: "networkidle" });
  await openFromCard();
  // All the post's versions are the footage.
  await page.waitForFunction((n) => document.querySelectorAll(".ve-media-item, .ve-source").length >= n || true, files.length);
  await page.waitForTimeout(3000);

  // Auto edit: build the cut, read what it did.
  await tab("Auto edit");
  await studio.getByRole("button", { name: /Build the cut/ }).click();
  await studio.getByTestId("auto-summary").waitFor({ timeout: 180000 });
  await page.waitForTimeout(500);
  result.summary = await studio.getByTestId("auto-summary").locator("li").allInnerTexts();
  result.clipsAfterAuto = await studio.locator(".ve-clip").count();
  if (result.clipsAfterAuto < 5) errors.push(`Auto edit filled ${result.clipsAfterAuto} clips.`);
  if (!result.summary.some((l) => l.startsWith("Hook:"))) errors.push(`The summary has no hook line: ${result.summary.join(" | ")}`);
  await page.screenshot({ path: join(outDir, "ui-auto-edit-1440.png") });

  // Edit like this video: Pinterest refused (the plain message), then an upload.
  await studio.getByRole("tab", { name: "Pinterest" }).click();
  await studio.getByLabel("Pinterest pin link").fill("https://www.pinterest.com/pin/123456789012/");
  await studio.getByRole("button", { name: "Fetch" }).click();
  await studio.locator(".vr-error").waitFor({ timeout: 30000 });
  result.pinterestMessage = await studio.locator(".vr-error").innerText();
  if (!/Upload/.test(result.pinterestMessage) || !/Drive/.test(result.pinterestMessage)) errors.push(`The Pinterest refusal should name the alternatives: ${result.pinterestMessage}`);
  await studio.getByRole("tab", { name: "Upload" }).click();
  const chooser = page.waitForEvent("filechooser");
  await studio.getByRole("button", { name: /Pick a video from this computer/ }).click();
  await (await chooser).setFiles(reference);
  await studio.getByTestId("reference-analysis").waitFor({ timeout: 180000 });
  result.facts = await studio.getByTestId("reference-analysis").locator(".vr-facts li").allInnerTexts();
  await studio.getByRole("button", { name: /Apply to my footage/ }).click();
  await studio.locator(".vr-result .ts-hint", { hasText: "Applied" }).waitFor({ timeout: 180000 });
  result.clipsAfterReference = await studio.locator(".ve-clip").count();
  await page.waitForTimeout(800);
  await page.screenshot({ path: join(outDir, "ui-reference-panel-1440.png") });

  // Compare the two videos.
  await studio.getByRole("button", { name: /Compare the two videos/ }).click();
  await compare.getByTestId("timing-table").waitFor({ timeout: 30000 });
  result.tableRows = await compare.locator(".vr-table tbody tr").count();
  result.offBy = await compare.locator(".vr-table tbody tr td:nth-child(6)").allInnerTexts();
  await compare.getByRole("button", { name: "Play both" }).click();
  await page.waitForTimeout(800);
  // While both play: the cut's clock (the compositor's player) and the reference <video>, sampled together.
  result.sync = await compare.evaluate(async (el) => {
    const out = [];
    for (let i = 0; i < 12; i++) {
      const cut = Number(el.querySelector(".vr-time").dataset.time);
      // The drift the view measured on both clocks at the same instant (its last tick).
      const diff = Number(el.querySelector("figure").dataset.drift);
      out.push({ cut: Math.round(cut * 1000) / 1000, diff });
      await new Promise((r) => setTimeout(r, 250));
    }
    return out;
  });
  result.syncMaxDiff = Math.max(...result.sync.slice(2).map((s) => Math.abs(s.diff)));
  if (result.syncMaxDiff > 0.1) errors.push(`The reference drifts from the cut by ${result.syncMaxDiff} s while playing.`);
  if (!(result.sync.at(-1).cut > result.sync[0].cut + 1)) errors.push(`The comparison did not play: ${JSON.stringify(result.sync)}`);
  await compare.getByRole("button", { name: "Pause" }).click();
  await page.waitForTimeout(600);
  result.pausedAt = await compare.evaluate((el) => ({ cut: Number(el.querySelector(".vr-time").dataset.time), ref: el.querySelector("video").currentTime }));
  await page.screenshot({ path: join(outDir, "ui-compare-1440.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(800);
  result.compareSideScroll390 = await noSideScroll();
  if (result.compareSideScroll390 > 1) errors.push(`The 390 px comparison scrolls sideways by ${result.compareSideScroll390}px.`);
  await page.screenshot({ path: join(outDir, "ui-compare-390.png") });
  await compare.evaluate((el) => (el.scrollTop = 2000));
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(outDir, "ui-compare-390-table.png") });
  await compare.getByRole("button", { name: "Close" }).click();
  await page.setViewportSize({ width: 1440, height: 900 });

  // Save draft: version 4 with the analysis and the summary, not the footage.
  await studio.getByRole("button", { name: /^Save draft$/ }).click();
  await page.waitForTimeout(1200);
  const doc = state.saves.at(-1);
  result.saved = doc ? { v: doc.v, clips: doc.clips.length, reference: doc.reference ? { shots: doc.reference.analysis.shots.length, source: doc.reference.analysis.source, appliedAt: !!doc.reference.appliedAt, chars: JSON.stringify(doc.reference).length } : null, edit: doc.edit?.summary?.slice(0, 2) } : null;
  if (!doc || doc.v !== 4 || !doc.reference || !doc.edit) errors.push(`The saved draft lacks the reference or the summary: ${JSON.stringify(result.saved)}`);

  // Reload, reopen: the summary, the analysis and the comparison table come back.
  await page.reload({ waitUntil: "networkidle" });
  await openFromCard();
  await tab("Auto edit");
  await studio.getByTestId("reference-analysis").waitFor({ timeout: 30000 });
  result.afterReload = { summary: (await studio.getByTestId("auto-summary").locator("li").allInnerTexts()).slice(0, 1), facts: (await studio.getByTestId("reference-analysis").locator(".vr-facts li").allInnerTexts()).slice(0, 1) };
  await studio.getByRole("button", { name: /Compare the two videos/ }).click();
  await compare.getByTestId("timing-table").waitFor({ timeout: 30000 });
  result.afterReload.rows = await compare.locator(".vr-table tbody tr").count();
  result.afterReload.asks = await compare.locator(".vr-missing").innerText().catch(() => "");
  await page.screenshot({ path: join(outDir, "ui-compare-after-reload-1440.png") });
  await compare.getByRole("button", { name: "Close" }).click();
  // 390 px: the Auto edit panel does not scroll sideways.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(500);
  await tab("Auto edit");
  result.panelSideScroll390 = await noSideScroll();
  if (result.panelSideScroll390 > 1) errors.push(`The 390 px Auto edit panel scrolls sideways by ${result.panelSideScroll390}px.`);
  await page.screenshot({ path: join(outDir, "ui-auto-edit-390.png") });
} catch (e) {
  errors.push(`smoke: ${String(e).split("\n")[0]}`);
  await page.screenshot({ path: join(outDir, "ui-error.png") }).catch(() => undefined);
}
console.log(JSON.stringify(result, null, 2));
if (outside.length) errors.push(`Network calls outside the test server: ${[...new Set(outside)].join(", ")}`);
await browser.close();
server.close();
if (errors.length) {
  console.error("FAILED:\n- " + errors.join("\n- "));
  process.exit(1);
}
console.log("OK");
