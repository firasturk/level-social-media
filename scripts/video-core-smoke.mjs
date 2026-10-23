/**
 * The video core in the real studio UI, end to end, in headless Chromium: the built app
 * (dist/client) served with a stateful mock of the studio's routes (one month, one post whose
 * client version is a 16:9 clip, the editor's projects and render jobs kept in memory, the render
 * upload stored and served back). It checks, on the screen and on the uploaded file:
 *   - the card's "Edit video" opens the editor on that clip, in its own frame (16:9);
 *   - the frame bar (9:16 · 4:5 · 1:1 · 16:9, Fill / Fit) and the playback bar are there, the
 *     timeline has its Video, Text, Logo and Music lanes;
 *   - choosing 9:16 changes the stage; a text layer is added; "Save draft" says "Draft saved ·
 *     Render needed";
 *   - a reload of the page and a reopen bring back the 9:16 frame and the text layer exactly;
 *   - "Render & update card" shows "Rendering n%", then "Rendered · on the card"; the file the
 *     server received is 1080×1920 (ffprobe), with an audio track; the job was reported and closed;
 *   - after closing, the card plays the new version (its file), not the old 16:9 clip.
 * Open-source Chromium has no H.264, so the page is told to use the engine's test codecs (VP9 +
 * Opus) through `localStorage["lsm-video-test-codecs"] = "vp9"`; everything else is the studio's
 * path. Screenshots at 1440 and 390 land in --out (default ./smoke).
 *
 * Usage:  npm run build && node scripts/video-core-smoke.mjs [--out dir]   (needs ffmpeg/ffprobe)
 */
import { createServer } from "node:http";
import { execFileSync, execSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
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
const outDir = args.includes("--out") ? args[args.indexOf("--out") + 1] : join(process.cwd(), "smoke");
await mkdir(outDir, { recursive: true });
const dist = join(process.cwd(), "dist", "client");
const work = mkdtempSync(join(tmpdir(), "video-core-smoke-"));

// The post's clip: three bands (red | green | blue), 640×360 landscape, VP9 + Opus, 3 s.
execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=red:s=214x360:r=30:d=3", "-f", "lavfi", "-i", "color=c=0x00ff00:s=212x360:r=30:d=3", "-f", "lavfi", "-i", "color=c=blue:s=214x360:r=30:d=3", "-f", "lavfi", "-i", "sine=f=440:d=3", "-filter_complex", "[0][1][2]hstack=3,format=yuv420p[v]", "-map", "[v]", "-map", "3:a", "-c:v", "libvpx-vp9", "-b:v", "600k", "-c:a", "libopus", "-b:a", "64k", join(work, "bands.mp4")]);
const CLIP = readFileSync(join(work, "bands.mp4"));
const PICTURE = readFileSync(join(process.cwd(), "public", "guide", "product.jpg"));

const NOW = Date.now();
const ADMIN = { id: "u1", email: "smoke@example.test", name: "Smoke", role: "admin" };
const CLIENT = { id: "c1", slug: "habibah", name: "Habibah", logo: false, badge: false, colors: [], fonts: {}, tone: "", dos: "", donts: "", style: "", gridRhythm: "", language: "en", status: "active", position: 0, batches: 1, updated: NOW, overlay: null, fontFiles: [], places: [] };
const POST = { index: 1, type: "offer", title: "Strength training", brief: "A strong product shot.", caption: "", hashtags: "", product: "", headline: "Move your way", subline: "", ideaAt: 1 };
const CONFIG = { mode: "post", input: "model", prompt: "", ratio: "4:5", size: "1K", count: 1, backdrop: "", market: "auto", skill: "editorial", economy: false, output: "jpg", outputQuality: 90, outputSize: "fit", colors: "", modelDescription: "", center: true, client: "c1", month: "2026-10", postCount: 1, format: "4:5", model: "nano-banana-pro", plan: [POST], plannedAt: 1 };
const BATCH = { id: "b1", name: "Habibah · October 2026", config: JSON.stringify(CONFIG), client: "c1", month: "2026-10", theme: null, state: "idle", last_error: null, created: NOW, updated: NOW };
const TASK = { id: "t1", source: "s1", card: 1, status: "ready", output: "u1/b1/output/t1/a.jpg", qa: JSON.stringify({ automated: true, flags: [], notes: "", found: true, count: 1, box: [], productConcern: false, centered: true }), error: null, prompt: "", attempts: 1, request_id: null, brief: null, cost: 0, updated: NOW, post: 1, made_for: 1 };
const SOURCE = { id: "s1", name: "p.jpg", mime: "image/jpeg", size: 1000, role: "lead", kind: "product", created: NOW };
const ACCESS = { admin: true, enabled: true, reason: "" };

/* ───────────── The stateful mock ───────────── */
const files = new Map([["v1", CLIP]]);
const item = (id, n, extra = {}) => ({ id, post: 1, model: "kling", provider: "higgsfield", source: "picture", prompt: "", status: "done", error: null, created: NOW + n, updated: NOW + n, duration: 3, aspect: null, resolution: null, estimate: null, forClient: false, requestId: null, url: `/api/studio/posts/video/file?batch=b1&id=${id}`, poster: null, preview: null, version: n, warnings: [], audioChoice: null, audioId: null, audioName: null, label: null, check: null, analysis: null, frame: "16:9", frameFill: null, words: null, width: 640, height: 360, project: null, ...extra });
const state = { videos: [item("v1", 1, { forClient: true })], card: null, projects: new Map(), renders: new Map(), uploads: [], reports: 0 };
const summary = () => {
  const done = [...state.videos].sort((a, b) => b.created - a.created);
  return { posts: { 1: { latest: done[0], client: done.find((v) => v.forClient) ?? null, done: done[0], card: state.card ? done.find((v) => v.id === state.card) : null } } };
};
const projectItem = (p) => ({ id: p.id, batch: "b1", post: 1, name: p.doc.name, rev: p.rev, sourceVideo: "v1", renderedVideo: p.rendered ?? null, created: NOW, updated: Date.now(), createdBy: "u1", updatedBy: "u1", clips: p.doc.clips.length });

async function body(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

async function api(req, res, path, u) {
  const send = (status, b) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(b));
  };
  const E = "/api/studio/posts/video/editor";
  if (path === "/api/studio/posts/video/file") {
    const data = files.get(u.searchParams.get("id"));
    if (!data) return send(404, { error: "Video not found." });
    res.writeHead(200, { "content-type": "video/mp4", "accept-ranges": "bytes", "content-length": data.length });
    return res.end(data);
  }
  if (path === "/api/studio/file") {
    res.writeHead(200, { "content-type": "image/jpeg" });
    return res.end(PICTURE);
  }
  if (path === "/api/studio/posts/video/list") return send(200, { videos: [...state.videos].sort((a, b) => b.created - a.created), engines: [], prices: {}, admin: true, access: ACCESS, billing: "credits" });
  if (path === "/api/studio/posts/video/summary") return send(200, summary());
  if (path === `${E}/projects` && req.method === "GET") return send(200, { projects: [...state.projects.values()].map(projectItem), access: ACCESS });
  if (path === `${E}/projects` && req.method === "POST") {
    const d = JSON.parse(await body(req));
    const p = { id: "p1", rev: 1, doc: { ...d.project, rev: 1 } };
    state.projects.set(p.id, p);
    return send(200, { project: projectItem(p), document: p.doc });
  }
  const pm = /^\/api\/studio\/posts\/video\/editor\/projects\/([^/]+)$/.exec(path);
  if (pm) {
    const p = state.projects.get(pm[1]);
    if (!p) return send(404, { error: "Project not found." });
    if (req.method === "PUT") {
      const d = JSON.parse(await body(req));
      if (d.rev !== p.rev) return send(409, { error: "Saved elsewhere.", rev: p.rev, stale: true });
      p.rev += 1;
      p.doc = { ...d.project, rev: p.rev };
    }
    return send(200, { project: projectItem(p), document: p.doc, access: ACCESS });
  }
  if (path === `${E}/renders` && req.method === "POST") {
    const d = JSON.parse(await body(req));
    const p = state.projects.get(d.projectId);
    if (!p || p.rev !== d.rev) return send(409, { error: "Save the draft first.", stale: true });
    const r = { id: `r${state.renders.size + 1}`, project: p.id, projectRev: p.rev, status: "rendering", progress: 0, phase: "starting", videoId: null, outcome: null, error: null, width: null, height: null, duration: null, created: Date.now(), updated: Date.now(), finished: null, createdBy: "u1" };
    state.renders.set(r.id, r);
    return send(200, { render: r, document: p.doc });
  }
  if (path === `${E}/renders` && req.method === "GET") return send(200, { renders: [...state.renders.values()].filter((r) => r.project === u.searchParams.get("project")).reverse() });
  const rm = /^\/api\/studio\/posts\/video\/editor\/renders\/([^/]+)\/(progress|fail)$/.exec(path);
  if (rm) {
    const r = state.renders.get(rm[1]);
    const d = JSON.parse(await body(req));
    if (rm[2] === "progress") {
      state.reports++;
      Object.assign(r, { progress: d.progress, phase: d.phase, status: d.phase === "uploading" ? "uploading" : "rendering", updated: Date.now() });
    } else Object.assign(r, { status: "failed", error: d.error });
    return send(200, { render: r });
  }
  if (path === `${E}/render` && req.method === "POST") {
    const form = await new Response(await body(req), { headers: { "content-type": req.headers["content-type"] } }).formData();
    const file = form.get("file");
    const bytes = Buffer.from(await file.arrayBuffer());
    const id = `v${state.videos.length + 1}`;
    files.set(id, bytes);
    const out = join(work, `${id}.mp4`);
    writeFileSync(out, bytes);
    const info = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", out], { encoding: "utf8" }));
    const v = info.streams.find((s) => s.codec_type === "video");
    const r = state.renders.get(String(form.get("renderId")));
    state.uploads.push({ id, renderId: r?.id ?? null, width: v.width, height: v.height, audio: info.streams.some((s) => s.codec_type === "audio"), duration: Number(info.format.duration), still: form.get("still") instanceof File });
    for (const x of state.videos) x.forClient = false;
    const made = item(id, state.videos.length + 1, { provider: "editor", source: "editor", frame: v.width < v.height ? "9:16" : "16:9", width: v.width, height: v.height, duration: Math.round(Number(info.format.duration) * 10) / 10, forClient: true, project: { id: "p1", rev: r?.projectRev ?? 0 } });
    state.videos.push(made);
    state.card = id;
    if (r) Object.assign(r, { status: "done", progress: 1, videoId: id, outcome: "card", width: v.width, height: v.height, duration: Number(info.format.duration), finished: Date.now() });
    return send(200, { video: made, project: null, render: r ?? null, outcome: "card" });
  }
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
    "/api/studio/drive/c1": { groups: { product: [], reference: [] }, photos: [], missing: [], demo: true },
    "/api/studio/ambassadors": { ambassadors: [] },
    "/api/studio/ocr/status": { connected: false, provider: "none", reason: "Not connected" },
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

const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || "/opt/pw-browsers/chromium", headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
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
    localStorage.setItem("lsm-video-test-codecs", "vp9");
  } catch {
    /* storage blocked */
  }
});

const result = {};
const studio = page.locator('[role="dialog"][aria-label="Video studio"]');
async function openFromCard() {
  const edit = page.locator(".pc-video-edit").first();
  await edit.waitFor({ state: "visible", timeout: 20000 });
  await edit.click();
  await studio.waitFor({ state: "visible", timeout: 20000 });
  await studio.locator(".ve-framebar").waitFor({ state: "visible", timeout: 20000 });
  await studio.locator(".ve-stage-msg").waitFor({ state: "detached", timeout: 30000 }).catch(() => undefined);
}
const chip = () => studio.locator(".ve-chip").innerText().then((t) => t.trim());
const frameOn = () => studio.locator(".ve-framebar .ve-seg").first().locator("button.on").innerText().then((t) => t.trim());
const canvasAspect = () => studio.locator(".ve-canvas").evaluate((c) => `${c.width}x${c.height}`);

try {
  await page.goto(`${url}/?client=c1&month=2026-10`, { waitUntil: "networkidle" });
  result.cardEditButton = await page.locator(".pc-video-edit").first().innerText().catch(() => "");
  await openFromCard();
  result.opensOn = await frameOn();
  if (result.opensOn !== "16:9") errors.push(`A new cut should open in its clip's frame (16:9), got ${result.opensOn}.`);
  result.canvasBefore = await canvasAspect();
  result.lanes = await studio.locator(".ve-lane-label").allInnerTexts().then((l) => l.map((x) => x.trim()).filter(Boolean));
  if (result.lanes.join(",") !== "Video,Text,Logo,Music") errors.push(`Lanes: ${result.lanes.join(",")}`);
  result.transport = { scrubber: await studio.locator(".ve-scrub").count(), mute: await studio.getByRole("button", { name: /^Mute$/ }).count(), fullscreen: await studio.getByRole("button", { name: /^Full screen$/ }).count() };
  // 9:16, a text layer, Save draft.
  await studio.locator(".ve-framebar button", { hasText: "9:16" }).click();
  result.canvasAfter = await canvasAspect();
  await studio.locator(".vs-tabs button", { hasText: "Text" }).click();
  await studio.getByRole("button", { name: /Add text at the playhead/ }).click();
  const words = studio.locator(".ve-panel textarea");
  await words.fill("MOVE YOUR WAY · تحرّك");
  await words.blur();
  await studio.getByRole("button", { name: /^Save draft$/ }).click();
  await page.waitForTimeout(800);
  result.chipAfterSave = await chip();
  if (result.chipAfterSave !== "Draft saved · Render needed") errors.push(`After Save draft the chip read "${result.chipAfterSave}".`);
  await page.screenshot({ path: join(outDir, "video-core-1440.png") });
  // Reload the page and reopen: the frame and the words come back.
  await page.reload({ waitUntil: "networkidle" });
  await openFromCard();
  result.afterReload = { frame: await frameOn(), canvas: await canvasAspect(), textLayers: await studio.locator(".ve-layer-block.text").allInnerTexts().then((l) => l.map((x) => x.trim())), chip: await chip() };
  if (result.afterReload.frame !== "9:16" || !result.afterReload.textLayers.some((t) => t.includes("MOVE YOUR WAY"))) errors.push(`The reopened project lost edits: ${JSON.stringify(result.afterReload)}`);
  // Render & update card.
  await studio.getByRole("button", { name: /Render & update card/ }).click();
  const seen = new Set();
  const until = Date.now() + 240000;
  while (Date.now() < until) {
    const c = await chip().catch(() => "");
    seen.add(c.replace(/\d+%/, "n%"));
    if (/^Rendered/.test(c) || /failed/i.test(c)) break;
    await page.waitForTimeout(500);
  }
  result.chipsDuringRender = [...seen];
  result.chipAfterRender = await chip();
  if (!/^Rendered · on the card/.test(result.chipAfterRender)) errors.push(`After the render the chip read "${result.chipAfterRender}" (${(await studio.locator(".ve-panel .warn").allInnerTexts()).join(" | ")}).`);
  if (!result.chipsDuringRender.some((c) => /^Rendering n%/.test(c))) errors.push("The chip never showed Rendering n%.");
  result.upload = state.uploads[0] ?? null;
  result.heartbeats = state.reports;
  if (!result.upload || result.upload.width !== 1080 || result.upload.height !== 1920) errors.push(`The uploaded render is not 1080×1920: ${JSON.stringify(result.upload)}`);
  if (result.upload && !result.upload.audio) errors.push("The uploaded render has no audio track.");
  if (!result.upload?.renderId) errors.push("The upload did not name its render job.");
  await page.screenshot({ path: join(outDir, "video-core-rendered-1440.png") });
  // Close: the card plays the new version.
  await studio.getByRole("button", { name: /^Close$/ }).first().click(); // the X (the Close button stays outside editing)
  await studio.waitFor({ state: "detached", timeout: 10000 }).catch(() => undefined);
  await page.waitForTimeout(1500);
  result.cardVideoSrc = await page.locator(".pc-video-preview video").first().getAttribute("src").catch(() => null);
  result.cardBadge = (await page.locator(".pc-video-badge").first().innerText().catch(() => "")).replace(/\s+/g, " ").trim();
  if (!result.cardVideoSrc || !result.cardVideoSrc.includes(`id=${result.upload?.id}`)) errors.push(`The card should play ${result.upload?.id}, it plays ${result.cardVideoSrc}.`);
  if (!/Reel 9:16/.test(result.cardBadge)) errors.push(`The card's badge should say Reel 9:16: "${result.cardBadge}".`);
  await page.screenshot({ path: join(outDir, "video-core-card-1440.png") });
  // The phone layout: no sideways scroll.
  await page.setViewportSize({ width: 390, height: 844 });
  await openFromCard();
  result.narrow = await page.evaluate(() => ({ scrollX: document.documentElement.scrollWidth - window.innerWidth }));
  if (result.narrow.scrollX > 1) errors.push(`The 390 px layout scrolls sideways by ${result.narrow.scrollX}px.`);
  await page.screenshot({ path: join(outDir, "video-core-390.png") });
} catch (e) {
  errors.push(`smoke: ${String(e).split("\n")[0]}`);
  await page.screenshot({ path: join(outDir, "video-core-error.png") }).catch(() => undefined);
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
