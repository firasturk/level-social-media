/**
 * A browser smoke test of the editors handing work to each other, in headless Chromium: the built
 * app (dist/client) is served with its API answered by a stateful mock (one month, one post with a
 * picture). The flow:
 *
 *   1. the card's "Edit picture" opens the Photo studio; Adjust: exposure up (not applied yet);
 *   2. "Text studio" in the top bar: the Text studio opens, nothing was uploaded; "Add text" adds a
 *      layer (the plan saves itself);
 *   3. "Video studio" in the Text studio's top bar, then "Photo studio" in the Video studio's: the
 *      Photo studio comes back with the adjustment still there (carried by the card's session);
 *   4. "Save & return": the adjusted picture is uploaded once, the studio closes, the same card is
 *      scrolled into view and highlighted and shows the new picture; reopening shows the saved
 *      state (no pending adjustment; the Text studio has the added layer);
 *   5. an approved card (the client approved it, the review link is out): the editors say so, a
 *      save is kept as a new version, the card keeps the approved picture and offers "Send it for
 *      review"; sending it makes the new version the client's;
 *   6. at 390 px the Photo and Text studios keep "Save & return" on screen (the Video studio's own
 *      save and render path belongs to the video editor's work, not this test).
 *
 * Screenshots land in --out (default: ./test-results/editor-continuity). No Worker, D1, wrangler or
 * provider is involved: the mock is in this file.
 *
 * Usage:  npm run build && node scripts/editor-continuity-smoke.mjs [--out dir]
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
const outDir = opt("--out", join(process.cwd(), "test-results", "editor-continuity"));
await mkdir(outDir, { recursive: true });
const executablePath = process.env.PW_CHROMIUM || "/opt/pw-browsers/chromium";
const dist = join(process.cwd(), "dist", "client");

function png(w, h, base) {
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
      raw.set(band ? base.map((v) => v - 50) : base, y * (1 + w * 3) + 1 + x * 3);
    }
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", new Uint8Array(deflateSync(raw))), chunk("IEND", new Uint8Array())];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return Buffer.from(out);
}
const PICTURES = { "a.png": png(540, 675, [120, 110, 100]), "b.png": png(540, 675, [200, 180, 160]), "c.png": png(540, 675, [90, 140, 200]) };

const NOW = Date.now();
const HELD = "The client approved the current version; your edit is saved as a new version. Send it for review to replace it.";
const ADMIN = { id: "u1", email: "smoke@example.test", name: "Smoke", role: "admin" };
const CLIENT = { id: "c1", slug: "habibah", name: "Habibah", logo: false, badge: false, colors: [{ name: "Pistachio", hex: "#8fbf6a" }], fonts: {}, tone: "", dos: "", donts: "", style: "", gridRhythm: "", language: "en", status: "active", position: 0, batches: 1, updated: NOW, overlay: null, fontFiles: [], places: [] };
const SOURCE = { id: "s1", name: "pistachio.jpg", mime: "image/jpeg", size: 1000, role: "lead", kind: "product", created: NOW };
const QA = JSON.stringify({ automated: true, flags: [], notes: "Looks right.", found: true, count: 1, box: [], productConcern: false, centered: true });

/** The mock's month: changed by the uploads, the plan saves and "Send it for review". */
const state = {};
function reset(approved) {
  state.approved = approved;
  state.plan = [{ index: 1, type: "offer", title: "Pistachio week", brief: "The pistachio kunafa on marble.", caption: "", hashtags: "", product: "pistachio", headline: "Pistachio week", subline: "This week only", ideaAt: 1 }];
  state.task = { id: "t1", source: "s1", card: 1, status: "ready", output: "u1/b1/output/t1/a.png", qa: QA, error: null, prompt: "", attempts: 1, request_id: null, brief: null, cost: 0.04, updated: NOW, post: 1, made_for: 1 };
  state.takes = [{ id: "tk1", index: 1, status: "made", key: "u1/b1/output/t1/a.png", image: "/api/studio/posts/versions/image?batch=b1&key=a.png", cost: 0.04, note: "first take", madeFor: 1, created: NOW - 60000, current: true }];
  state.uploads = [];
  state.planSaves = [];
  state.sent = [];
}
const config = () => ({ mode: "post", input: "model", prompt: "", ratio: "4:5", size: "1K", count: 1, backdrop: "", market: "auto", skill: "editorial", economy: false, output: "jpg", outputQuality: 90, outputSize: "fit", colors: "", modelDescription: "", center: true, client: "c1", month: "2026-10", postCount: 1, format: "4:5", model: "nano-banana-pro", plan: state.plan, plannedAt: 1, ...(state.approved ? { shareToken: "f".repeat(32), approvals: { "1": { status: "approved", by: "Rana", at: NOW, answers: [{ rid: "rid-rana", status: "approved", by: "Rana", at: NOW }] } } } : {}) });
const batch = () => ({ id: "b1", name: "Habibah · October 2026", config: JSON.stringify(config()), client: "c1", month: "2026-10", theme: null, state: "idle", last_error: null, created: NOW, updated: NOW });
const ACCESS = { admin: true, enabled: true, reason: "" };

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".woff2": "font/woff2", ".json": "application/json", ".ico": "image/x-icon" };
const readBody = (req) => new Promise((ok) => {
  const parts = [];
  req.on("data", (c) => parts.push(c));
  req.on("end", () => ok(Buffer.concat(parts)));
});

function api(path, u) {
  const fixed = {
    "/api/auth/me": { user: ADMIN, registrationOpen: false },
    "/api/studio/state": { user: ADMIN, batches: [batch()], trash: [], spend: [], spendThreshold: 20, clients: [CLIENT], engine: { model: "nano-banana-pro", configured: false, source: "none", openai: "none", google: "none", fal: "none", review: false, vertex: null }, preview: true, workflowV2: true },
    "/api/studio/batch": { batch: batch(), sources: [SOURCE], tasks: [state.task] },
    "/api/studio/engine/models": { models: [] },
    "/api/studio/styles/pending": { n: 0 },
    "/api/studio/lessons/pending": { n: 0 },
    "/api/studio/posts/themes": { themes: [] },
    "/api/studio/posts/takes": { takes: state.takes },
    "/api/studio/posts/versions": { versions: [] },
    "/api/studio/posts/video/summary": { posts: {} },
    "/api/studio/posts/video/list": { videos: [], engines: [], prices: {}, admin: true, access: ACCESS, billing: "credits" },
    "/api/studio/posts/video/editor/projects": { projects: [], access: ACCESS },
    "/api/studio/posts/video/audio/list": { tracks: [], access: ACCESS, generated: { connected: false, reason: "Not connected" } },
    "/api/studio/higgsfield/mcp/status": { signedIn: false, email: "", plan: "", credits: null, balanceError: "", billing: "credits", billingChosen: true, cloudConfigured: false, admin: true, switch: { enabled: true }, access: ACCESS, url: "", device: null },
    "/api/studio/higgsfield/mcp/models": { models: [], at: NOW },
    "/api/studio/video/presets": { ok: true, category: u.searchParams.get("category") ?? "popular", categories: [{ id: "popular", label: "Popular", hint: "" }], items: [], nextCursor: null, cachedAt: NOW, cached: true, signedIn: true, admin: true, access: ACCESS, billing: "credits", reason: "", empty: "Nothing in this category on your plan yet." },
    "/api/studio/video/magnific/status": { ok: true, connected: false, source: null, admin: true, access: ACCESS, tools: [], reason: "Not connected" },
    "/api/studio/video/higgsfield/tools": { ok: true, signedIn: false, billing: "credits", admin: true, access: ACCESS, reason: "", available: {}, tools: [], checks: [] },
    "/api/studio/photolab/status": { connected: false, provider: "demo", reason: "No key", prices: {}, approximate: true, access: ACCESS },
    "/api/studio/photolab/jobs": { jobs: [] },
    "/api/studio/freepik/status": { connected: false, demo: true, reason: "No key", admin: true, access: "admin", plan: "unknown", planLabel: "", downloadEstimate: null, entitlements: {}, mcp: { connected: false, url: "" }, switch: { enabled: true, reason: "" } },
    "/api/studio/freepik/assets": { assets: [] },
    "/api/studio/drive/c1": { groups: { product: [], reference: [] }, photos: [], missing: [], demo: true },
    "/api/studio/ambassadors": { ambassadors: [] },
    "/api/studio/publish/status": { connected: false },
    "/api/studio/publish": { publications: [] },
    "/api/studio/ocr/status": { connected: false, provider: "none", reason: "Not connected" },
    "/api/studio/photo/tools/catalog": { ok: true, admin: true, tools: [], higgsfield: { provider: "higgsfield", connected: false, enabled: true, admin: true, reason: "", balance: null, available: {} }, magnific: { provider: "magnific", connected: false, enabled: true, admin: true, reason: "", balance: null, available: {} }, upscalePresets: [], upscaleModes: [], retouchModels: [], cachedAt: NOW },
    "/api/studio/photo/tools/jobs": { ok: true, jobs: [] },
    "/api/studio/photo/presets": { ok: true, category: "styles", categories: [], provider: "higgsfield", items: [], cachedAt: NOW, cached: true, signedIn: false, admin: true, access: ACCESS, reason: "", empty: "" },
  };
  return fixed[path];
}

async function startStatic() {
  const server = createServer(async (req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    const path = decodeURIComponent(u.pathname);
    const send = (body, status = 200) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (path === "/api/studio/file" || path === "/api/studio/posts/versions/image") {
      const name = (u.searchParams.get("v") ?? u.searchParams.get("key") ?? "a.png").split("/").pop();
      res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" });
      res.end(PICTURES[name] ?? PICTURES["a.png"]);
      return;
    }
    if (path === "/api/studio/posts/picture/upload" && req.method === "POST") {
      const body = await readBody(req);
      state.uploads.push({ bytes: body.length, type: req.headers["content-type"] ?? "" });
      if (state.approved) {
        // The client holds the post: the new version is kept beside it.
        const key = "u1/b1/output/t1/c.png";
        state.takes = [{ id: "tk3", index: 1, status: "made", key, image: "/api/studio/posts/versions/image?batch=b1&key=c.png", cost: 0, note: "Adjusted · new version (the client's version stays)", madeFor: 1, created: Date.now(), current: false }, ...state.takes];
        return send({ ok: true, task: "t1", key, previous: state.task.output, current: state.task.output, held: "approved", message: HELD });
      }
      const key = "u1/b1/output/t1/b.png";
      state.takes = [{ id: "tk2", index: 1, status: "made", key, image: "/api/studio/posts/versions/image?batch=b1&key=b.png", cost: 0, note: "Adjusted in the Photo studio", madeFor: 1, created: Date.now(), current: true }, ...state.takes.map((t) => ({ ...t, current: false }))];
      state.task = { ...state.task, output: key, updated: Date.now() };
      return send({ ok: true, task: "t1", key, previous: "u1/b1/output/t1/a.png", current: key, held: null });
    }
    if (path === "/api/studio/posts/plan" && req.method === "PUT") {
      const body = JSON.parse((await readBody(req)).toString() || "{}");
      state.plan = body.plan ?? state.plan;
      state.planSaves.push(body.plan);
      return send({ ok: true, plan: state.plan });
    }
    if (path === "/api/studio/posts/versions/send-for-review" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)).toString() || "{}");
      state.sent.push(body);
      if (body.key) state.task = { ...state.task, output: body.key, updated: Date.now() };
      state.approved = false;
      return send({ ok: true, picture: body.key ?? null, videoId: null, reopened: true });
    }
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
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
const outside = [];
const pictureRequests = [];
page.on("pageerror", (e) => errors.push(`page error: ${String(e)}`));
// "Failed to fetch": a request the page had in flight (the captions written for a new picture) cut by the next scenario's reload.
page.on("console", (m) => m.type() === "error" && !/favicon|404|media resource|Failed to load resource|Failed to fetch/.test(m.text()) && errors.push(`console error: ${m.text()}`));
const ALLOWED = [url, "data:", "blob:", "https://fonts.googleapis.com/", "https://fonts.gstatic.com/"];
page.on("request", (r) => {
  const u = r.url();
  if (!ALLOWED.some((a) => u.startsWith(a))) outside.push(u);
  if (u.includes("/api/studio/file")) pictureRequests.push(u);
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

const photo = page.locator('[role="dialog"][aria-label="Photo studio"]');
const text = page.locator('[role="dialog"][aria-label="Text studio"]');
const video = page.locator('[role="dialog"][aria-label="Video studio"]');
const card = page.locator("#post-card-1");
const setExposure = async (v) => {
  await photo.locator(".ps-rail button, .ps-bottom button").filter({ hasText: "Adjust" }).first().click();
  const exposure = photo.locator('input[aria-label="Exposure"]');
  await exposure.waitFor({ state: "visible", timeout: 10000 });
  await exposure.evaluate((el, value) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, String(v));
};
const exposureValue = () => photo.locator('input[aria-label="Exposure"]').inputValue();
const openPhoto = async () => {
  await card.getByRole("button", { name: /^Edit picture$/ }).click();
  await photo.waitFor({ state: "visible", timeout: 20000 });
  await photo.locator(".ps-picture, .ps-stage").first().waitFor({ state: "visible", timeout: 10000 });
};
/** "Save & return" is on screen (inside the viewport) in the editor's top bar. */
const saveReturnVisible = async (dialog) => {
  const b = dialog.locator(".ts-save-return");
  if (!(await b.isVisible())) return false;
  const box = await b.boundingBox();
  const vp = page.viewportSize();
  return !!box && box.x >= 0 && box.y >= 0 && box.x + box.width <= vp.width + 1 && box.y + box.height <= vp.height;
};

const result = {};
try {
  reset(false);
  await page.goto(`${url}/?client=c1&month=2026-10`, { waitUntil: "networkidle" });
  await card.waitFor({ state: "visible", timeout: 20000 });

  // 1. Photo studio: an adjustment, not applied yet.
  await openPhoto();
  await setExposure(60);
  await photo.locator(".ts-save.dirty").waitFor({ state: "visible", timeout: 5000 });
  result.photoSaveReturn1440 = await saveReturnVisible(photo);
  await page.screenshot({ path: join(outDir, "1440-photo-adjusted.png") });

  // 2. → Text studio: nothing uploaded, the adjustment is carried; add a text layer.
  await photo.getByRole("button", { name: /Text studio/ }).click();
  await text.waitFor({ state: "visible", timeout: 20000 });
  await photo.waitFor({ state: "detached", timeout: 10000 });
  result.uploadsAfterSwitch = state.uploads.length;
  if (state.uploads.length !== 0) errors.push("Switching to the Text studio should not upload anything.");
  result.sessionAfterSwitch = await page.evaluate(() => JSON.parse(sessionStorage.getItem("lsm-edit-session:b1:1") ?? "null"));
  if (result.sessionAfterSwitch?.photo?.adjust?.exposure !== 60) errors.push(`The card's session should carry the exposure: ${JSON.stringify(result.sessionAfterSwitch?.photo)}`);
  await text.locator(".ts-layers .ts-layer").first().waitFor({ state: "visible", timeout: 15000 });
  const layersBefore = await text.locator(".ts-layers .ts-layer").count();
  await text.getByRole("button", { name: "Add text" }).click();
  await page.waitForFunction((n) => document.querySelectorAll('[aria-label="Text studio"] .ts-layers .ts-layer').length > n, layersBefore, { timeout: 5000 });
  result.layersAfterAdd = await text.locator(".ts-layers .ts-layer").count();
  await page.waitForFunction(() => document.querySelector('[aria-label="Text studio"] .ts-save')?.textContent === "Saved", null, { timeout: 8000 }).catch(() => undefined);
  result.textSaveReturn1440 = await saveReturnVisible(text);
  await page.screenshot({ path: join(outDir, "1440-text-added.png") });

  // 3. → Video studio → back to the Photo studio: the adjustment is still there.
  await text.getByRole("button", { name: /Video studio/ }).click();
  await video.waitFor({ state: "visible", timeout: 20000 });
  await page.screenshot({ path: join(outDir, "1440-video.png") });
  await video.getByRole("button", { name: /Photo studio/ }).click();
  await photo.waitFor({ state: "visible", timeout: 20000 });
  await photo.locator(".ts-save.dirty").waitFor({ state: "visible", timeout: 5000 }).catch(() => undefined);
  result.adjustmentCarried = (await photo.locator(".ts-save.dirty").count()) === 1;
  if (!result.adjustmentCarried) errors.push("Back in the Photo studio the adjustment should still be pending.");
  await photo.locator(".ps-rail button").filter({ hasText: "Adjust" }).click();
  result.exposureCarried = await exposureValue();
  if (result.exposureCarried !== "60") errors.push(`The exposure should come back as 60, found ${result.exposureCarried}`);
  result.planSaves = state.planSaves.length;
  const savedDesign = state.plan[0]?.ov?.design;
  result.savedLayers = savedDesign?.layers?.length ?? 0;
  if (result.savedLayers !== result.layersAfterAdd) errors.push(`The Text studio's layer should be saved with the plan (${result.layersAfterAdd} layers), found ${result.savedLayers}`);

  // 4. Save & return: one upload, the studio closes, the same card is in view, highlighted, with the new picture.
  const before = pictureRequests.length;
  await photo.locator(".ts-save-return").click();
  await photo.waitFor({ state: "detached", timeout: 15000 });
  result.uploadsAfterReturn = state.uploads.length;
  if (state.uploads.length !== 1) errors.push(`Save & return should upload the adjusted picture once, saw ${state.uploads.length}`);
  result.flashed = await page.waitForFunction(() => document.getElementById("post-card-1")?.classList.contains("pc-flash"), null, { timeout: 4000 }).then(() => true).catch(() => false);
  if (!result.flashed) errors.push("The card should be highlighted after Save & return.");
  await page.waitForTimeout(900);
  result.cardInView = await card.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return r.bottom > 0 && r.top < window.innerHeight;
  });
  if (!result.cardInView) errors.push("The card should be scrolled into view after Save & return.");
  await page.waitForFunction(() => [...document.querySelectorAll("#post-card-1 img")].some((i) => /v=b\.png/.test(i.currentSrc || i.src) || i.src.startsWith("data:")), null, { timeout: 8000 }).catch(() => undefined);
  result.newPictureRequested = pictureRequests.slice(before).some((u) => /v=b\.png/.test(u));
  if (!result.newPictureRequested) errors.push("The card should show the saved picture (b.png).");
  result.sessionAfterReturn = await page.evaluate(() => JSON.parse(sessionStorage.getItem("lsm-edit-session:b1:1") ?? "null"));
  if (result.sessionAfterReturn?.photo) errors.push("Nothing should be pending after Save & return.");
  await page.screenshot({ path: join(outDir, "1440-returned.png") });

  // Reopen: the saved state (no pending adjustment; the Text studio has the added layer).
  await openPhoto();
  result.reopenDirty = await photo.locator(".ts-save.dirty").count();
  if (result.reopenDirty) errors.push("Reopening the Photo studio should show no pending adjustment.");
  await photo.getByRole("button", { name: /Text studio/ }).click();
  await text.waitFor({ state: "visible", timeout: 20000 });
  await text.locator(".ts-layers .ts-layer").first().waitFor({ state: "visible", timeout: 15000 });
  result.reopenLayers = await text.locator(".ts-layers .ts-layer").count();
  if (result.reopenLayers !== result.layersAfterAdd) errors.push(`Reopening the Text studio should show ${result.layersAfterAdd} layers, found ${result.reopenLayers}`);
  await text.locator(".ts-save-return").click();
  await text.waitFor({ state: "detached", timeout: 10000 });

  // 5. An approved card keeps its approved version.
  reset(true);
  await page.goto(`${url}/?client=c1&month=2026-10`, { waitUntil: "networkidle" });
  await card.waitFor({ state: "visible", timeout: 20000 });
  await openPhoto();
  result.holdNote = (await photo.locator(".ts-hold").innerText().catch(() => "")).trim();
  if (!/Client approved/.test(result.holdNote)) errors.push(`The Photo studio should say the client approved this post, read "${result.holdNote}"`);
  await setExposure(-40);
  await photo.locator(".ts-save-return").click();
  await photo.waitFor({ state: "detached", timeout: 15000 });
  result.approvedUploads = state.uploads.length;
  result.approvedTaskOutput = state.task.output;
  if (state.task.output !== "u1/b1/output/t1/a.png") errors.push("The approved picture should stay the post's picture.");
  const notice = card.locator(".pc-session-row.held");
  await notice.waitFor({ state: "visible", timeout: 8000 });
  result.heldNotice = (await notice.locator("span").first().innerText()).trim();
  if (result.heldNotice !== HELD) errors.push(`The card should say "${HELD}", read "${result.heldNotice}"`);
  await page.screenshot({ path: join(outDir, "1440-approved-held.png") });
  await notice.getByRole("button", { name: /Send it for review/ }).click();
  await page.getByRole("button", { name: /^Send it for review$/ }).last().click();
  await notice.waitFor({ state: "detached", timeout: 8000 });
  result.sentForReview = state.sent;
  if (state.sent.length !== 1 || state.sent[0].key !== "u1/b1/output/t1/c.png") errors.push(`"Send it for review" should send the new version: ${JSON.stringify(state.sent)}`);

  // 6. 390 px: "Save & return" stays on screen in every editor.
  reset(false);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${url}/?client=c1&month=2026-10`, { waitUntil: "networkidle" });
  await card.waitFor({ state: "visible", timeout: 20000 });
  await card.scrollIntoViewIfNeeded();
  await openPhoto();
  result.photoSaveReturn390 = await saveReturnVisible(photo);
  await page.screenshot({ path: join(outDir, "390-photo.png") });
  await photo.getByRole("button", { name: /Text studio/ }).click();
  await text.waitFor({ state: "visible", timeout: 20000 });
  result.textSaveReturn390 = await saveReturnVisible(text);
  await page.screenshot({ path: join(outDir, "390-text.png") });
  await text.getByRole("button", { name: /Video studio/ }).click();
  await video.waitFor({ state: "visible", timeout: 20000 });
  await page.screenshot({ path: join(outDir, "390-video.png") });
  await video.getByRole("button", { name: /Photo studio/ }).click();
  await photo.waitFor({ state: "visible", timeout: 20000 });
  await photo.locator(".ts-save-return").click();
  await photo.waitFor({ state: "detached", timeout: 10000 });
  result.sideScroll390 = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  await page.screenshot({ path: join(outDir, "390-returned.png") });
  for (const k of ["photoSaveReturn1440", "textSaveReturn1440", "photoSaveReturn390", "textSaveReturn390"]) if (!result[k]) errors.push(`"Save & return" should be on screen: ${k}`);
} catch (e) {
  errors.push(`The flow stopped: ${e instanceof Error ? e.message : String(e)}`);
  await page.screenshot({ path: join(outDir, "failed.png") }).catch(() => undefined);
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
