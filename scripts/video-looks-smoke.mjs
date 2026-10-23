/**
 * Phase 3 in the real studio UI, in headless Chromium: the built app (dist/client) served with a
 * stateful mock of the studio's routes (one month, one post with a 16:9 clip and a pinned
 * reference picture, the editor's projects in memory, the music library's catalog with its
 * generated test track). It checks on the screen and in the saved draft:
 *   - Media: "Start from a template" lists six templates with schematic thumbnails; "Product
 *     launch" fills the timeline (5 shots) after a confirm;
 *   - Colour: six preset thumbnails drawn from the current frame; Warm Film chosen, the intensity
 *     set; Split view; the colour matched to the post's reference picture;
 *   - Music: the music library lists the catalog; picking a track shows its licence, the credit
 *     line with Copy, and Content ID;
 *   - Save draft: the stored document is the current version (4 since edit quality) with the look, its intensity, the match, the
 *     template and the catalog source with its rights; after a reload and reopen they are back;
 *   - 390 px: the Colour, Media and Music panels do not scroll sideways (screenshots).
 * Usage:  npm run build && node scripts/video-looks-smoke.mjs [--out dir]   (needs ffmpeg)
 */
import { createServer } from "node:http";
import { execFileSync, execSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "vite";

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
const root = process.cwd();
const dist = join(root, "dist", "client");
const work = mkdtempSync(join(tmpdir(), "video-looks-smoke-"));

// The post's clip: a cool scene in bands, 640×360, VP9 + Opus, 3 s; the post's reference: a warm picture.
const ff = (...a) => execFileSync("ffmpeg", ["-v", "error", "-y", ...a]);
ff("-f", "lavfi", "-i", "color=c=0x40607f:s=640x120:r=30:d=3", "-f", "lavfi", "-i", "color=c=0xe1af91:s=640x120:r=30:d=3", "-f", "lavfi", "-i", "color=c=0xa0b8d0:s=640x120:r=30:d=3", "-f", "lavfi", "-i", "sine=f=440:d=3", "-filter_complex", "[0][1][2]vstack=3,noise=alls=5:allf=t,format=yuv420p[v]", "-map", "[v]", "-map", "3:a", "-c:v", "libvpx-vp9", "-b:v", "600k", "-c:a", "libopus", "-b:a", "64k", join(work, "clip.mp4"));
ff("-f", "lavfi", "-i", "color=c=0xd08850:s=300x150:d=1", "-f", "lavfi", "-i", "color=c=0xf0c890:s=300x150:d=1", "-filter_complex", "[0][1]vstack=2[v]", "-map", "[v]", "-frames:v", "1", join(work, "ref.png"));
const CLIP = readFileSync(join(work, "clip.mp4"));
const REF = readFileSync(join(work, "ref.png"));
const PICTURE = readFileSync(join(root, "public", "guide", "product.jpg"));
// The catalog's generated test track, from the shared code.
const entry = join(work, "music-entry.ts");
writeFileSync(entry, `export { synthTestWav } from ${JSON.stringify(join(root, "shared", "music-test-audio.ts"))};\nexport { catalogEntry } from ${JSON.stringify(join(root, "shared", "music-catalog.ts"))};\n`);
await build({ configFile: false, logLevel: "warn", resolve: { alias: { "@shared": join(root, "shared") } }, build: { ssr: entry, outDir: join(work, "node"), emptyOutDir: true, minify: false, rollupOptions: { output: { format: "es", entryFileNames: "music.mjs" } } } });
const { synthTestWav, catalogEntry } = await import(pathToFileURL(join(work, "node", "music.mjs")).href);
const E = catalogEntry("test-beat-120");
const WAV = Buffer.from(synthTestWav(E.synth));
const TRACK = { id: "cat:test-beat-120", kind: "catalog", title: E.title, artist: E.artist, moods: E.moods, genre: E.genre, duration: E.duration, bpm: E.bpm, bpmSource: E.bpmSource, test: E.test, source: { name: E.source.name, page: E.source.page, author: E.source.author }, licence: E.licence, contentId: E.contentId, url: "/api/studio/music/file?id=cat%3Atest-beat-120", peaksUrl: "/api/studio/music/peaks?id=cat%3Atest-beat-120", stored: true };
const K = catalogEntry("upbeat-forever");
// A CC BY track the list shows (its file is not served: picking it is not part of this run).
const KEVIN = { ...TRACK, id: "cat:upbeat-forever", title: K.title, artist: K.artist, moods: K.moods, genre: K.genre, duration: K.duration, bpm: K.bpm, test: false, source: { name: K.source.name, page: K.source.page, author: K.source.author }, licence: K.licence, contentId: K.contentId, url: "/api/studio/music/file?id=cat%3Aupbeat-forever", peaksUrl: "/api/studio/music/peaks?id=cat%3Aupbeat-forever" };

const NOW = Date.now();
const ADMIN = { id: "u1", email: "smoke@example.test", name: "Smoke", role: "admin" };
const CLIENT = { id: "c1", slug: "habibah", name: "Habibah", logo: false, badge: false, colors: [], fonts: {}, tone: "", dos: "", donts: "", style: "", gridRhythm: "", language: "en", status: "active", position: 0, batches: 1, updated: NOW, overlay: null, fontFiles: [], places: [] };
const POST = { index: 1, type: "offer", title: "Strength training", brief: "A strong product shot.", caption: "", hashtags: "", product: "", headline: "Move your way", subline: "", ideaAt: 1, reference: { key: "u1/b1/ref/1.png", thumb: "u1/b1/ref/1.png", name: "Sunset pin", at: 5, source: "pinterest" } };
const CONFIG = { mode: "post", input: "model", prompt: "", ratio: "4:5", size: "1K", count: 1, backdrop: "", market: "auto", skill: "editorial", economy: false, output: "jpg", outputQuality: 90, outputSize: "fit", colors: "", modelDescription: "", center: true, client: "c1", month: "2026-10", postCount: 1, format: "4:5", model: "nano-banana-pro", plan: [POST], plannedAt: 1 };
const BATCH = { id: "b1", name: "Habibah · October 2026", config: JSON.stringify(CONFIG), client: "c1", month: "2026-10", theme: null, state: "idle", last_error: null, created: NOW, updated: NOW };
const TASK = { id: "t1", source: "s1", card: 1, status: "ready", output: "u1/b1/output/t1/a.jpg", qa: JSON.stringify({ automated: true, flags: [], notes: "", found: true, count: 1, box: [], productConcern: false, centered: true }), error: null, prompt: "", attempts: 1, request_id: null, brief: null, cost: 0, updated: NOW, post: 1, made_for: 1 };
const SOURCE = { id: "s1", name: "p.jpg", mime: "image/jpeg", size: 1000, role: "lead", kind: "product", created: NOW };
const ACCESS = { admin: true, enabled: true, reason: "" };
const item = (id, n, extra = {}) => ({ id, post: 1, model: "kling", provider: "higgsfield", source: "picture", prompt: "", status: "done", error: null, created: NOW + n, updated: NOW + n, duration: 3, aspect: null, resolution: null, estimate: null, forClient: false, requestId: null, url: `/api/studio/posts/video/file?batch=b1&id=${id}`, poster: null, preview: null, version: n, warnings: [], audioChoice: null, audioId: null, audioName: null, label: null, check: null, analysis: null, frame: "16:9", frameFill: null, words: null, width: 640, height: 360, project: null, ...extra });
const state = { videos: [item("v1", 1, { forClient: true })], projects: new Map(), saves: [], musicFile: 0, refReads: 0 };
const projectItem = (p) => ({ id: p.id, batch: "b1", post: 1, name: p.doc.name, rev: p.rev, sourceVideo: "v1", renderedVideo: null, created: NOW, updated: Date.now(), createdBy: "u1", updatedBy: "u1", clips: p.doc.clips.length });

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
  const bytes = (type, data) => {
    res.writeHead(200, { "content-type": type, "accept-ranges": "bytes", "content-length": data.length });
    res.end(data);
  };
  const ED = "/api/studio/posts/video/editor";
  if (path === "/api/studio/posts/video/file") return bytes("video/mp4", CLIP);
  if (path === "/api/studio/file") return bytes("image/jpeg", PICTURE);
  if (path === "/api/studio/posts/reference/image") {
    state.refReads++;
    return bytes("image/png", REF);
  }
  if (path === "/api/studio/music/catalog") return send(200, { tracks: [TRACK, KEVIN], total: 2, moods: [{ id: "upbeat", label: "Upbeat" }], genres: ["Test audio", "Ska"], access: { admin: true, enabled: true, reason: "" } });
  if (path === "/api/studio/music/library") return send(200, { tracks: [], total: 0, moods: [], genres: [], access: { admin: true, enabled: true, reason: "" } });
  if (path === "/api/studio/music/peaks") return send(200, { peaks: null });
  if (path === "/api/studio/music/file") {
    if (u.searchParams.get("id") !== TRACK.id) return send(404, { error: "Not in this test." });
    state.musicFile++;
    return bytes("audio/wav", WAV);
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
const tab = (name) => studio.locator(".vs-tabs button", { hasText: name }).click();
const noSideScroll = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

try {
  await page.goto(`${url}/?client=c1&month=2026-10`, { waitUntil: "networkidle" });
  await openFromCard();

  // Media: the templates.
  await tab("Media");
  const head = studio.getByRole("button", { name: /Start from a template/ });
  if ((await studio.locator(".vl-template").count()) === 0) await head.click();
  result.templates = await studio.locator(".vl-template span").allInnerTexts();
  if (result.templates.length !== 6) errors.push(`Six templates expected: ${result.templates.join(", ")}`);
  result.schematics = await studio.locator(".vl-template svg").count();
  await studio.locator('.vl-template[data-template="product-launch"]').click();
  await studio.getByRole("button", { name: /Use this template/ }).click();
  await page.getByRole("button", { name: "Use the template" }).click();
  await page.waitForTimeout(500);
  result.clipsAfterTemplate = await studio.locator(".ve-clip").count();
  if (result.clipsAfterTemplate !== 5) errors.push(`Product launch should fill 5 shots, the timeline has ${result.clipsAfterTemplate}.`);
  await page.screenshot({ path: join(outDir, "looks-templates-1440.png") });

  // Colour: thumbnails from the current frame, Warm Film at 60 %, split view, match to the post's reference.
  await studio.locator(".ve-scrub").fill("1");
  await tab("Colour");
  await studio.getByRole("button", { name: "Whole video" }).click();
  await studio.locator(".vl-preset img").nth(5).waitFor({ state: "visible", timeout: 20000 });
  result.thumbnails = await studio.locator(".vl-preset img").evaluateAll((l) => l.map((i) => i.getAttribute("src")?.slice(0, 22)));
  result.thumbnailsDistinct = await studio.locator(".vl-preset img").evaluateAll((l) => new Set(l.map((i) => i.getAttribute("src"))).size);
  if (result.thumbnails.length !== 6 || result.thumbnailsDistinct !== 6) errors.push(`Six distinct preset thumbnails expected: ${result.thumbnails.length}, ${result.thumbnailsDistinct} distinct.`);
  await studio.locator('.vl-preset[data-preset="warm-film"]').click();
  await studio.getByLabel("Preset intensity").fill("0.6");
  await studio.getByRole("button", { name: "Split", exact: true }).click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(outDir, "looks-colour-split-1440.png") });
  await studio.getByRole("button", { name: "Split", exact: true }).click();
  await studio.locator(".vl-ref").first().click();
  await studio.getByRole("button", { name: /^Match / }).click();
  await studio.locator(".vl-chosen", { hasText: "Matched to" }).waitFor({ timeout: 60000 });
  result.match = (await studio.locator(".vl-chosen", { hasText: "Matched to" }).innerText()).replace(/\s+/g, " ");
  await page.screenshot({ path: join(outDir, "looks-colour-1440.png") });

  // Music: the library, a catalog track, its rights.
  await tab("Music");
  const lib = studio.locator(".ml-track-main", { hasText: "Test beat" }).first();
  await lib.waitFor({ timeout: 20000 });
  await lib.click();
  await studio.getByRole("button", { name: /Use in this video/ }).first().click();
  await studio.getByTestId("music-rights").waitFor({ timeout: 20000 });
  result.rights = (await studio.getByTestId("music-rights").innerText()).replace(/\s+/g, " ");
  await page.screenshot({ path: join(outDir, "looks-music-1440.png") });
  result.musicFileReads = state.musicFile;

  // Save draft: what the server received.
  await studio.getByRole("button", { name: /^Save draft$/ }).click();
  await page.waitForTimeout(800);
  const doc = state.saves.at(-1);
  result.saved = doc ? { v: doc.v, look: doc.look, lookAmount: doc.lookAmount, template: doc.template, matches: doc.clips.filter((c) => c.match).length, matchRef: doc.clips.find((c) => c.match)?.match.ref, music: doc.music?.source ? { kind: doc.music.source.kind, trackId: doc.music.source.trackId, credit: !!doc.music.source.rights?.credit, contentId: doc.music.source.rights?.contentId?.status } : null } : null;
  if (!doc || doc.v !== 4 || doc.look !== "warm-film" || Math.abs(doc.lookAmount - 0.6) > 0.011 || doc.template?.id !== "product-launch" || !doc.clips.some((c) => c.match) || doc.music?.source.kind !== "catalog") errors.push(`The saved draft lacks phase-3 fields: ${JSON.stringify(result.saved)}`);

  // Reload and reopen: the look, the match and the track come back.
  await page.reload({ waitUntil: "networkidle" });
  await openFromCard();
  await tab("Colour");
  await studio.getByRole("button", { name: "Whole video" }).click();
  result.afterReload = { preset: await studio.locator(".vl-preset.on span").innerText().catch(() => ""), intensity: await studio.getByLabel("Preset intensity").inputValue() };
  await tab("Music");
  await studio.getByTestId("music-rights").waitFor({ timeout: 20000 });
  result.afterReload.rights = (await studio.getByTestId("music-rights").innerText()).slice(0, 60);
  result.afterReload.musicFileReads = state.musicFile;
  if (result.afterReload.preset !== "Warm Film" || Math.abs(Number(result.afterReload.intensity) - 0.6) > 0.011) errors.push(`After a reopen the look is ${JSON.stringify(result.afterReload)}`);

  // 390 px: no sideways scroll on the three panels.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);
  result.narrow = {};
  for (const name of ["Colour", "Media", "Music"]) {
    await tab(name);
    await page.waitForTimeout(400);
    result.narrow[name] = await noSideScroll();
    if (result.narrow[name] > 1) errors.push(`The 390 px ${name} panel scrolls sideways by ${result.narrow[name]}px.`);
    await page.screenshot({ path: join(outDir, `looks-${name.toLowerCase()}-390.png`), fullPage: false });
    const side = studio.locator(".ts-side-body");
    await side.evaluate((el) => (el.scrollTop = 600)).catch(() => undefined);
    await page.screenshot({ path: join(outDir, `looks-${name.toLowerCase()}-390-scrolled.png`), fullPage: false });
  }
} catch (e) {
  errors.push(`smoke: ${String(e).split("\n")[0]}`);
  await page.screenshot({ path: join(outDir, "looks-error.png") }).catch(() => undefined);
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
