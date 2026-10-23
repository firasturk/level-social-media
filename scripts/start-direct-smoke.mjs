/**
 * A browser smoke test of Start's four options and the two direct-to-Studio routes in headless
 * Chromium: the built app (dist/client, from `npm run build`) is served statically with the
 * studio's answers mocked (a signed-in admin, one client, one month with one post, a Drive listing
 * with pictures and two clips). It checks that Start shows exactly four cards of one size with the
 * same buttons, that "Create or edit video" opens the selection dialog with the client's Drive,
 * that Drive picks and computer files share one tray, that confirming sends one request with both
 * kinds and lands straight on the Studio cards (no Direction, no Plan) with the new cards chosen,
 * and that two clip cards combine into one video project that opens in the Video editor. At 390 px
 * the four cards stack with no sideways scroll. Screenshots at 1440 and 390 land in --out
 * (default: ./test-results/start-direct). No Worker, no D1, no provider is involved: any request
 * outside this server fails the run.
 *
 * Usage:  npm run build && node scripts/start-direct-smoke.mjs [--out dir]
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
const outDir = opt("--out", join(process.cwd(), "test-results", "start-direct"));
await mkdir(outDir, { recursive: true });
const executablePath = process.env.PW_CHROMIUM || "/opt/pw-browsers/chromium";
const dist = join(process.cwd(), "dist", "client");
const SAMPLE_MP4 = await readFile(join(process.cwd(), "tests", "fixtures", "sample-1s.mp4"));

/** A real PNG of one colour with a darker band. */
function png(w, h, rgb = [120, 110, 100]) {
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
      raw.set(band ? rgb.map((v) => Math.round(v * 0.6)) : rgb, y * (1 + w * 3) + 1 + x * 3);
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
const PICTURE = png(540, 675);
const DRIVE_PICTURES = { "d-mango": png(320, 320, [242, 162, 27]), "d-pist": png(320, 320, [143, 191, 106]), "d-rose": png(320, 320, [214, 112, 140]), "d-clip1": png(320, 320, [40, 40, 48]), "d-clip2": png(320, 320, [70, 60, 90]) };

const NOW = Date.now();
const ADMIN = { id: "u1", email: "smoke@example.test", name: "Smoke", role: "admin" };
const CLIENT = { id: "c1", slug: "habibah", name: "Habibah", logo: false, badge: false, colors: [{ name: "Pistachio", hex: "#8fbf6a" }], fonts: {}, tone: "", dos: "", donts: "", style: "", gridRhythm: "", language: "en", status: "active", position: 0, batches: 1, updated: NOW, overlay: null, fontFiles: [], places: [] };
const POST = { index: 1, type: "offer", title: "Pistachio week", brief: "The pistachio kunafa on marble.", caption: "", hashtags: "", product: "pistachio", headline: "Pistachio week", subline: "This week only", ideaAt: 1 };
const config = { mode: "post", input: "model", prompt: "", ratio: "4:5", size: "1K", count: 1, backdrop: "", market: "auto", skill: "editorial", economy: false, output: "jpg", outputQuality: 90, outputSize: "fit", colors: "", modelDescription: "", center: true, client: "c1", month: "2026-10", postCount: 1, format: "4:5", model: "nano-banana-pro", plan: [POST], plannedAt: 1 };
const batch = () => ({ id: "b1", name: "Habibah · October 2026", config: JSON.stringify(config), client: "c1", month: "2026-10", theme: null, state: "idle", last_error: null, created: NOW, updated: NOW });
const tasks = [{ id: "t1", source: "s1", card: 1, status: "ready", output: "u1/b1/output/t1/a.png", qa: JSON.stringify({ automated: true, flags: [], notes: "Looks right.", found: true, count: 1, box: [], productConcern: false, centered: true }), error: null, prompt: "", attempts: 1, request_id: null, brief: null, cost: 0.04, updated: NOW, post: 1, made_for: 1 }];
const SOURCE = { id: "s1", name: "pistachio.jpg", mime: "image/jpeg", size: 1000, role: "lead", kind: "product", created: NOW };
const videoRows = {};
const photo = (id, file, folder, extra = {}) => ({ id, file, name: file.replace(/\.[a-z0-9]+$/i, ""), folder, w: 1080, h: 1350, modified: "2026-09-01T09:00:00.000Z", role: "product", ...extra });
const DRIVE = {
  link: "",
  email: "studio@example.iam.gserviceaccount.com",
  folder: "Habibah",
  folders: [{ id: "f1", name: "Habibah", role: "product", approved: true, link: "https://drive.google.com/drive/folders/f1" }],
  photos: [photo("d-mango", "Mango cup.jpg", "Drinks"), photo("d-pist", "Pistachio shake.jpg", "Drinks"), photo("d-rose", "Rose latte.jpg", "Drinks"), photo("d-clip1", "Pouring shot.mp4", "Clips", { video: true }), photo("d-clip2", "Shop door.mp4", "Clips", { video: true })],
  groups: { product: [], brand: [], reference: [], output: [] },
  missing: [],
  demo: false,
};
DRIVE.groups.product = DRIVE.photos;

/** What the browser sent: the intake and combine requests, read as forms. */
const sent = { intake: [], combine: [] };

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".woff2": "font/woff2", ".json": "application/json", ".ico": "image/x-icon" };
const readBody = (req) => new Promise((resolve) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => resolve(Buffer.concat(chunks)));
});

async function startStatic() {
  let base = "";
  const server = createServer(async (req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    const path = decodeURIComponent(u.pathname);
    const json = (body) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (path.startsWith("/fixtures/")) {
      const mp4 = path.endsWith(".mp4");
      res.writeHead(200, { "content-type": mp4 ? "video/mp4" : "image/png", "accept-ranges": "bytes", "cache-control": "no-store" });
      res.end(mp4 ? SAMPLE_MP4 : PICTURE);
      return;
    }
    if (path.startsWith("/api/")) {
      if (path === "/api/studio/file" || path === "/api/studio/posts/video/poster") {
        res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" });
        res.end(PICTURE);
        return;
      }
      if (path.startsWith("/api/studio/drive/photo/")) {
        res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" });
        res.end(DRIVE_PICTURES[path.split("/").pop()] ?? PICTURE);
        return;
      }
      if (path === "/api/studio/posts/video/file") {
        res.writeHead(200, { "content-type": "video/mp4", "accept-ranges": "bytes" });
        res.end(SAMPLE_MP4);
        return;
      }
      if (req.method === "POST" && (path === "/api/studio/media/intake" || path === "/api/studio/media/combine")) {
        const body = await readBody(req);
        const form = await new Request("http://x", { method: "POST", headers: { "content-type": req.headers["content-type"] }, body }).formData();
        const items = JSON.parse(String(form.get("items") ?? "[]"));
        if (path.endsWith("/intake")) {
          const files = items.map((it) => (it.from === "upload" ? { from: "upload", name: form.get(it.field)?.name, type: form.get(it.field)?.type } : { from: "drive", id: it.id }));
          sent.intake.push({ kind: form.get("kind"), batch: form.get("batch"), files });
          let next = config.plan.reduce((m, p) => Math.max(m, p.index), 0);
          const created = files.map((f) => {
            const index = ++next;
            const name = f.from === "drive" ? DRIVE.photos.find((p) => p.id === f.id).file : f.name;
            const kind = /\.mp4$/i.test(name) ? "video" : "image";
            config.plan.push({ index, type: "lifestyle", title: name.replace(/\.[a-z0-9]+$/i, ""), brief: "", caption: "", hashtags: "", ideaAt: NOW, source: "media", media: { kind, from: f.from, name, fp: `${f.from}:${name}`, at: NOW } });
            tasks.push({ ...tasks[0], id: `t${index}`, card: index, post: index, output: `u1/b1/output/t${index}/a.png`, qa: null, made_for: NOW });
            if (kind === "video") videoRows[index] = { id: `v${index}`, status: "done", url: `/api/studio/posts/video/file?batch=b1&id=v${index}`, provider: "upload", source: "upload", forClient: true, created: NOW, version: 1 };
            return { index, kind, name, from: f.from };
          });
          config.postCount = config.plan.length;
          json({ ok: true, batch: "b1", created, existing: [] });
        } else {
          sent.combine.push({ target: form.get("target"), items });
          const index = config.plan.reduce((m, p) => Math.max(m, p.index), 0) + 1;
          config.plan.push({ index, type: "lifestyle", title: "Combined video", brief: "", caption: "", hashtags: "", ideaAt: NOW, source: "media", media: { kind: "video", from: "combine", name: "Combined video", fp: "combine:1", at: NOW } });
          tasks.push({ ...tasks[0], id: `t${index}`, card: index, post: index, qa: null, made_for: NOW });
          json({ ok: true, target: index, created: true, project: "p1", clips: items.map((it) => `copy-${it.post}`) });
        }
        return;
      }
      const MOCK = {
        "/api/auth/me": { user: ADMIN, registrationOpen: false },
        "/api/studio/state": { user: ADMIN, batches: [batch()], trash: [], spend: [], spendThreshold: 20, clients: [CLIENT], engine: { model: "nano-banana-pro", configured: false, source: "none", openai: "none", google: "none", fal: "none", review: false, vertex: null }, preview: true, workflowV2: true },
        "/api/studio/batch": { batch: batch(), sources: [SOURCE], tasks },
        "/api/studio/engine/models": { models: [] },
        "/api/studio/styles/pending": { n: 0 },
        "/api/studio/styles/start-pictures": { brief: [], refs: [], style: null, grid: null },
        "/api/studio/lessons/pending": { n: 0 },
        "/api/studio/posts/themes": { themes: [] },
        "/api/studio/posts/takes": { takes: [] },
        "/api/studio/posts/versions": { versions: [] },
        "/api/studio/posts/drafts": { draft: null },
        "/api/studio/posts/plan-preview": { posts: [], planned: 0, paid: 0, blocked: [], notes: [], issues: [], estimate: { model: "nano-banana-pro", size: "1K", perImage: 0.04, total: 0, maximum: 0, known: true, retakes: 0 }, spend: { approved: 0, reserved: 0, remaining: 20 } },
        "/api/studio/media/clip": { ok: true, clip: { batch: "b1", id: "v0", url: `${base}/fixtures/clip.mp4`, poster: `${base}/fixtures/clip.png` } },
        "/api/studio/posts/video/summary": { posts: Object.fromEntries(Object.entries(videoRows).map(([k, v]) => [k, { latest: v, client: v, done: v }])) },
        "/api/studio/posts/video/list": { videos: [], engines: [], prices: {}, admin: true, access: { admin: true, enabled: true, reason: "" }, billing: "credits" },
        "/api/studio/posts/video/editor/projects": { projects: [], access: { admin: true, enabled: true, reason: "" } },
        "/api/studio/posts/video/audio/list": { tracks: [], access: { admin: true, enabled: true, reason: "" }, generated: { connected: false, reason: "Not connected" } },
        "/api/studio/higgsfield/mcp/status": { signedIn: false, admin: true, switch: { enabled: true }, access: { admin: true, enabled: true, reason: "" }, billing: "credits", billingChosen: true },
        "/api/studio/higgsfield/mcp/models": { models: [], at: NOW },
        "/api/studio/video/presets": { ok: true, category: "popular", categories: [], items: [], nextCursor: null, cachedAt: NOW, cached: true, signedIn: false, admin: true, access: { admin: true, enabled: true, reason: "" }, billing: "credits", reason: "", empty: "Nothing here." },
        "/api/studio/photolab/status": { connected: false, provider: "demo", reason: "No key", prices: {}, approximate: true, access: { admin: true, enabled: true, reason: "" } },
        "/api/studio/freepik/status": { connected: false, demo: true, reason: "No key", admin: true, access: "admin", plan: "unknown", planLabel: "", downloadEstimate: null, entitlements: {}, mcp: { connected: false, url: "" }, switch: { enabled: true, reason: "" } },
        "/api/studio/drive/c1": DRIVE,
        "/api/studio/ambassadors": { ambassadors: [] },
        "/api/studio/publish/status": { connected: false },
        "/api/studio/publish": { publications: [] },
        "/api/studio/ocr/status": { connected: false, provider: "none", reason: "Not connected" },
      };
      const body = MOCK[path] ?? (path.includes("/list") || path.endsWith("s") ? [] : {});
      json(body);
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
const errors = [];
const outside = [];
const ALLOWED = [url, "data:", "blob:", "https://fonts.googleapis.com/", "https://fonts.gstatic.com/"];

async function newPage(width, height) {
  const page = await browser.newPage({ viewport: { width, height } });
  page.on("pageerror", (e) => errors.push(`page error (${width}): ${String(e)}`));
  page.on("console", (m) => m.type() === "error" && !/favicon|404|media resource|Failed to load resource|H\.264|decode/i.test(m.text()) && errors.push(`console error (${width}): ${m.text()}`));
  page.on("request", (r) => {
    const u = r.url();
    if (!ALLOWED.some((a) => u.startsWith(a))) outside.push(u);
  });
  await page.addInitScript(() => {
    try {
      localStorage.setItem("lsm-client", "c1");
    } catch {
      /* storage blocked */
    }
  });
  return page;
}

/** Opens the workflow on Start: the month has a plan, so it opens on Plan and the rail goes back to Start. */
async function openStart(page) {
  await page.goto(`${url}/?client=c1&month=2026-10`, { waitUntil: "networkidle" });
  const flow = page.locator(".journey.flow");
  await flow.waitFor({ state: "visible", timeout: 20000 });
  const start = flow.locator(".flow-stage", { hasText: "Start" }).first();
  if (await start.isVisible().catch(() => false)) await start.click();
  await flow.locator(".flow-ways.four").waitFor({ state: "visible", timeout: 20000 });
  return flow;
}

const result = {};
const desktop = await newPage(1440, 1000);
try {
  const flow = await openStart(desktop);
  const cards = flow.locator(".flow-ways.four .flow-way");
  result.cards = await cards.count();
  if (result.cards !== 4) errors.push(`Start should show exactly 4 cards, found ${result.cards}`);
  result.titles = await flow.locator(".flow-way-title").allInnerTexts();
  const want = ["Quick Campaign", "Follow a grid", "Edit images", "Create or edit video"];
  if (JSON.stringify(result.titles) !== JSON.stringify(want)) errors.push(`The cards should be ${want.join(", ")}; found ${result.titles.join(", ")}`);
  const boxes = await cards.evaluateAll((els) => els.map((e) => e.getBoundingClientRect()).map((r) => [Math.round(r.width), Math.round(r.height)]));
  result.sizes = boxes;
  if (new Set(boxes.map((b) => b.join("x"))).size !== 1) errors.push(`The four cards should share one size, found ${boxes.map((b) => b.join("x")).join(", ")}`);
  const arts = await flow.locator(".flow-ways.four .flow-way-art").evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height)));
  if (new Set(arts).size !== 1) errors.push(`The four pictures should share one height, found ${arts.join(", ")}`);
  result.buttons = await flow.locator(".flow-ways.four .flow-way").evaluateAll((els) => els.map((e) => [...e.querySelectorAll(".flow-way-buttons .cta")].map((b) => b.textContent.trim())));
  if (JSON.stringify(result.buttons) !== JSON.stringify([["Write a brief"], ["Pick a grid"], ["Choose from Drive", "Upload files"], ["Choose from Drive", "Upload files"]])) errors.push(`The cards' buttons are not as designed: ${JSON.stringify(result.buttons)}`);
  const heights = await flow.locator(".flow-ways.four .flow-way-buttons .cta").evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height)));
  if (new Set(heights).size !== 1) errors.push(`Every card button should share one height, found ${heights.join(", ")}`);
  result.tags = await flow.locator(".flow-way-tag").allInnerTexts();
  if (result.tags.length !== 2 || !result.tags.every((t) => /Direct to Studio/.test(t))) errors.push(`The two direct cards should carry "Direct to Studio", found ${JSON.stringify(result.tags)}`);
  result.videoCardUsesAutoplay = (await flow.locator('.flow-way[data-way="video"] .flow-art-video .apv').count()) === 1;
  if (!result.videoCardUsesAutoplay) errors.push("The video card should show the client's clip through the shared autoplay preview.");
  result.noOldCards = (await flow.getByText(/Use theme references|One post from a style/).count()) === 0;
  if (!result.noOldCards) errors.push("The old Start cards (theme references, one post from a style) are still shown.");
  await desktop.screenshot({ path: join(outDir, "start-1440.png") });

  // Create or edit video: the Drive and this computer in one tray.
  await flow.locator('.flow-way[data-way="video"]').getByRole("button", { name: "Choose from Drive" }).click();
  const dialog = desktop.locator(".media-dialog");
  await dialog.waitFor({ state: "visible", timeout: 10000 });
  await dialog.locator(".media-thumb").first().waitFor({ state: "visible", timeout: 10000 });
  result.driveThumbs = await dialog.locator(".media-thumb").count();
  await dialog.locator(".media-thumb", { hasText: "Pouring shot" }).click();
  await dialog.locator(".media-thumb", { hasText: "Shop door" }).click();
  await dialog.locator(".media-thumb", { hasText: "Mango cup" }).click();
  await dialog.getByRole("tab", { name: /This computer/ }).click();
  await dialog.locator('input[type="file"]').setInputFiles([
    { name: "storefront.png", mimeType: "image/png", buffer: png(400, 500, [30, 90, 160]) },
    { name: "reel.mp4", mimeType: "video/mp4", buffer: SAMPLE_MP4 },
  ]);
  await dialog.locator(".media-tray-item").nth(4).waitFor({ state: "visible", timeout: 5000 });
  result.tray = await dialog.locator(".media-tray-item").count();
  if (result.tray !== 5) errors.push(`The tray should hold 5 files (3 from Drive, 2 from the computer), found ${result.tray}`);
  result.traySources = await dialog.locator(".media-src").allInnerTexts();
  if (!result.traySources.includes("Drive") || !result.traySources.includes("Computer")) errors.push(`The tray should mix Drive and Computer files, found ${result.traySources.join(", ")}`);
  // A file can be taken out of the tray.
  await dialog.locator(".media-tray-x").nth(2).click();
  result.trayAfterRemove = await dialog.locator(".media-tray-item").count();
  if (result.trayAfterRemove !== 4) errors.push(`Removing one file should leave 4, found ${result.trayAfterRemove}`);
  await desktop.screenshot({ path: join(outDir, "dialog-1440-mixed.png") });
  await dialog.getByRole("button", { name: /Create 4 cards and open the Studio/ }).click();

  // Straight to the Studio cards: no Direction, no Plan; the new cards arrive chosen.
  await desktop.locator(".studio-select-bar").waitFor({ state: "visible", timeout: 20000 });
  result.flowClosed = (await desktop.locator(".journey.flow").count()) === 0;
  if (!result.flowClosed) errors.push("Confirming should leave the workflow for the Studio.");
  result.intake = sent.intake;
  const files = sent.intake.flatMap((r) => r.files);
  if (sent.intake.length !== 1 || sent.intake[0].kind !== "video" || sent.intake[0].batch !== "b1") errors.push(`One video intake on month b1 was expected, got ${JSON.stringify(sent.intake)}`);
  if (JSON.stringify(files.map((f) => f.from)) !== JSON.stringify(["drive", "drive", "upload", "upload"])) errors.push(`The request should carry 2 Drive files then 2 uploads, got ${JSON.stringify(files)}`);
  result.studioCards = await desktop.locator(".post-card.compact").count();
  if (result.studioCards !== 5) errors.push(`The Studio should show the month's post and 4 new cards, found ${result.studioCards}`);
  result.chosen = (await desktop.locator(".studio-select-bar b").innerText()).trim();
  if (!/^4 cards chosen/.test(result.chosen)) errors.push(`The 4 new cards should arrive chosen, found "${result.chosen}"`);
  result.mediaTags = await desktop.locator(".pc-media-tag").count();
  await desktop.screenshot({ path: join(outDir, "studio-1440-new-cards.png") });

  // Combine the two Drive clips (posts 2 and 3) into one video.
  await desktop.locator(".studio-select-bar").getByRole("button", { name: "Clear" }).click();
  // The sticky bar stays over the top of the list: each tick is brought to the middle first.
  for (const n of [3, 2]) {
    const tick = desktop.locator(`#post-card-${n} .pc-select`);
    await tick.evaluate((el) => el.scrollIntoView({ block: "center" }));
    await tick.click();
  }
  result.chosenOrder = await desktop.locator(".post-card.selected .pc-select-n").allInnerTexts();
  await desktop.locator(".studio-select-bar").getByRole("button", { name: /Combine into one video/ }).click();
  const combine = desktop.locator(".combine-dialog");
  await combine.waitFor({ state: "visible", timeout: 10000 });
  result.combineList = await combine.locator(".combine-list li b").allInnerTexts();
  await desktop.screenshot({ path: join(outDir, "combine-1440.png") });
  await combine.getByRole("button", { name: /Combine 2 and open the editor/ }).click();
  const studio = desktop.locator('[role="dialog"][aria-label="Video studio"]');
  await studio.waitFor({ state: "visible", timeout: 20000 });
  result.editorOpened = true;
  result.combine = sent.combine;
  if (sent.combine.length !== 1 || JSON.stringify(sent.combine[0].items) !== JSON.stringify([{ post: 3 }, { post: 2 }]) || sent.combine[0].target !== "new") errors.push(`The combine should send posts 3 then 2 to a new card, got ${JSON.stringify(sent.combine)}`);
  await desktop.screenshot({ path: join(outDir, "editor-1440-combined.png") });
} catch (e) {
  errors.push(`The desktop flow stopped: ${e instanceof Error ? e.message : String(e)}`);
  await desktop.screenshot({ path: join(outDir, "failed-1440.png") }).catch(() => undefined);
}

// 390 px: the four cards stack, no sideways scroll; the dialog fits.
const phone = await newPage(390, 844);
try {
  const flow = await openStart(phone);
  const cards = flow.locator(".flow-ways.four .flow-way");
  result.phoneCards = await cards.count();
  if (result.phoneCards !== 4) errors.push(`At 390 px Start should show 4 cards, found ${result.phoneCards}`);
  const widths = await cards.evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().width)));
  if (new Set(widths).size !== 1) errors.push(`At 390 px the cards should share one width, found ${widths.join(", ")}`);
  const overflow = await phone.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  if (overflow) errors.push("Start scrolls sideways at 390 px.");
  await phone.screenshot({ path: join(outDir, "start-390.png") });
  // The workflow is a layer of its own: its cards are brought into view one after the other for a second picture.
  await flow.locator('.flow-way[data-way="video"]').evaluate((el) => el.scrollIntoView({ block: "end" }));
  await phone.screenshot({ path: join(outDir, "start-390-direct.png") });
  await flow.locator('.flow-way[data-way="images"]').getByRole("button", { name: "Choose from Drive" }).click();
  const dialog = phone.locator(".media-dialog");
  await dialog.waitFor({ state: "visible", timeout: 10000 });
  await dialog.locator(".media-thumb").first().waitFor({ state: "visible", timeout: 10000 });
  // Edit images: clips are listed but cannot be picked.
  result.phoneClipDisabled = await dialog.locator(".media-thumb", { hasText: "Pouring shot" }).isDisabled();
  if (!result.phoneClipDisabled) errors.push("Edit images should not let a clip be picked.");
  await dialog.locator(".media-thumb", { hasText: "Rose latte" }).click();
  const dialogOverflow = await dialog.evaluate((d) => d.scrollWidth > d.clientWidth + 1);
  if (dialogOverflow) errors.push("The dialog scrolls sideways at 390 px.");
  await phone.screenshot({ path: join(outDir, "dialog-390.png") });
} catch (e) {
  errors.push(`The phone flow stopped: ${e instanceof Error ? e.message : String(e)}`);
  await phone.screenshot({ path: join(outDir, "failed-390.png") }).catch(() => undefined);
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
