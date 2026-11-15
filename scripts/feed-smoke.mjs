/**
 * A browser smoke test of the Studio board's Feed tab in headless Chromium, on the built app
 * (dist/client, from `npm run build`) with the studio's answers mocked. The month is the one of
 * scripts/export-smoke.mjs: six finished pictures, each carrying a logo and an Arabic headline.
 * The Feed tab must be a view of the board (not a door to another screen): six picture tiles, three
 * across, the newest post first, each with its words drawn on; a tile opens its post. The Classic
 * journey was retired on 15 Nov 2026: no "Classic journey" is left anywhere on the page, the More
 * menu included. A month with no pictures shows six empty tiles, each with its post's title.
 * No Worker, no D1, no provider is involved: any request outside this server fails the run.
 *
 * Usage:  npm run build && node scripts/feed-smoke.mjs [--out dir]
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
const outDir = opt("--out", join(process.cwd(), "test-results", "feed"));
await mkdir(outDir, { recursive: true });
const executablePath = process.env.PW_CHROMIUM || "/opt/pw-browsers/chromium";
const dist = join(process.cwd(), "dist", "client");

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

const NOW = Date.now();
const ADMIN = { id: "u1", email: "smoke@example.test", name: "Smoke", role: "admin" };
const CLIENT = { id: "c1", slug: "habibah", name: "Habibah", logo: false, badge: false, colors: [{ name: "Pistachio", hex: "#8fbf6a" }], fonts: {}, tone: "", dos: "", donts: "", style: "", gridRhythm: "", language: "en", status: "active", position: 0, batches: 1, updated: NOW, overlay: null, fontFiles: [], places: [] };
const POST = { index: 1, type: "offer", title: "Pistachio week", brief: "The pistachio kunafa on marble.", caption: "", hashtags: "", product: "pistachio", headline: "Pistachio week", subline: "This week only", ideaAt: 1 };
const config = { mode: "post", input: "model", prompt: "", ratio: "4:5", size: "1K", count: 1, backdrop: "", market: "auto", skill: "editorial", economy: false, output: "jpg", outputQuality: 90, outputSize: "fit", colors: "", modelDescription: "", center: true, client: "c1", month: "2026-10", postCount: 1, format: "4:5", model: "nano-banana-pro", plan: [POST], plannedAt: 1 };
const batch = () => ({ id: "b1", name: "Habibah · December 2026", config: JSON.stringify(config), client: "c1", month: "2026-12", theme: null, state: "idle", last_error: null, created: NOW, updated: NOW });
const tasks = [{ id: "t1", source: "s1", card: 1, status: "ready", output: "u1/b1/output/t1/a.png", qa: JSON.stringify({ automated: true, flags: [], notes: "Looks right.", found: true, count: 1, box: [], productConcern: false, centered: true }), error: null, prompt: "", attempts: 1, request_id: null, brief: null, cost: 0.04, updated: NOW, post: 1, made_for: 1 }];
const SOURCE = { id: "s1", name: "pistachio.jpg", mime: "image/jpeg", size: 1000, role: "lead", kind: "product", created: NOW };

// The month of scripts/export-smoke.mjs: six posts in a series, each with a picture, a logo and an Arabic headline.
const COMMENT_AT = NOW - 1000;
const design = (headline) => ({ version: 1, layers: [{ id: "L1", name: "Logo", x: 0.4075, y: 0.035, type: "logo", w: 0.185 }, { id: "L2", type: "text", name: "Headline", role: "headline", text: headline, x: 0.1, y: 0.704, w: 0.8, font: "Tajawal", weight: 700, size: 0.078, lineHeight: 1.15, align: "center", autoSize: true, fill: { type: "solid", color: "#ffffff" } }], canvas: { gradient: { color: "#030619", angle: 180, from: 0, to: 0.55 } } });
const HEADLINES = ["سلامتكم أولاً في كل رحلة", "قيادة آمنة في الأجواء الماطرة", "دفء البيت.. وراحة بال", "صحتك أولوية بكل الفصول", "جهّز بيتك للشتا", "خطط لبكرا براحة بال"];
config.plan = HEADLINES.map((headline, i) => ({ index: i + 1, type: "lifestyle", title: `Post ${i + 1}`, brief: "A calm winter scene.", caption: "نص الكابشن", hashtags: "#تأمين", headline, ov: { design: design(headline) }, date: `2026-12-${String(2 + i * 4).padStart(2, "0")}`, captionHand: true, ideaAt: COMMENT_AT, group: { id: "g1", kind: "series", slide: i + 1, of: 6 }, clientNote: { note: "Caption: نص جديد", at: COMMENT_AT, summary: "The picture stays; only the caption changes." }, clientSteps: { at: COMMENT_AT, steps: [{ tool: "rewrite", what: "Keep the shot; replace the caption." }] } }));
config.postCount = 6;
config.month = "2026-12";
const TASK0 = tasks[0];
tasks.length = 0;
for (let i = 1; i <= 6; i++) tasks.push({ ...TASK0, id: `t${i}`, card: i, post: i, output: `u1/b1/output/t${i}/a.png`, made_for: COMMENT_AT - 5000 });
CLIENT.logo = true;
/** Flipped by the run: a month with no pictures. */
let empty = false;
const LOGO = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 80"><rect width="200" height="80" fill="#0a7bd6"/><circle cx="40" cy="40" r="22" fill="#fff"/></svg>';

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".woff2": "font/woff2", ".json": "application/json", ".ico": "image/x-icon" };

async function startStatic() {
  let base = "";
  const server = createServer(async (req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    const path = decodeURIComponent(u.pathname);
    const json = (body) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (path.startsWith("/api/")) {
      if (path === "/api/studio/file") {
        res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" });
        res.end(PICTURE);
        return;
      }
      if (/^\/api\/studio\/clients\/[^/]+\/logo$/.test(path)) {
        res.writeHead(200, { "content-type": "image/svg+xml", "cache-control": "no-store" });
        res.end(LOGO);
        return;
      }
      if (path === "/api/studio/posts/captions.csv") {
        res.writeHead(200, { "content-type": "text/csv; charset=utf-8" });
        res.end("post,title,caption\n1,Post 1,caption\n");
        return;
      }
      const MOCK = {
        "/api/auth/me": { user: ADMIN, registrationOpen: false },
        "/api/studio/state": { user: ADMIN, batches: [batch()], trash: [], spend: [], spendThreshold: 20, clients: [CLIENT], engine: { model: "nano-banana-pro", configured: false, source: "none", openai: "none", google: "none", fal: "none", review: false, vertex: null }, preview: true, workflowV2: true },
        "/api/studio/batch": { batch: batch(), sources: [SOURCE], tasks: empty ? [] : tasks },
        "/api/studio/engine/models": { models: [] },
        "/api/team/bootstrap": { me: { id: "u1", name: "Smoke", role: "admin" }, users: [], channels: [], unread: 0, tasksOpen: 0, cursor: NOW },
        "/api/team/sync": { cursor: NOW, messages: [], notifications: [], channels: [], unread: 0, tasksOpen: 0 },
        "/api/team/notifications": { notifications: [] },
        "/api/studio/styles/pending": { n: 0 },
        "/api/studio/styles/start-pictures": { brief: [], refs: [], style: null, grid: null },
        "/api/studio/lessons/pending": { n: 0 },
        "/api/studio/posts/themes": { themes: [] },
        "/api/studio/posts/takes": { takes: [] },
        "/api/studio/posts/versions": { versions: [] },
        "/api/studio/posts/drafts": { draft: null },
        "/api/studio/posts/plan-preview": { posts: [], planned: 0, paid: 0, blocked: [], notes: [], issues: [], estimate: { model: "nano-banana-pro", size: "1K", perImage: 0.04, total: 0, maximum: 0, known: true, retakes: 0 }, spend: { approved: 0, reserved: 0, remaining: 20 } },
        "/api/studio/media/clip": { ok: true, clip: { batch: "b1", id: "v0", url: `${base}/fixtures/clip.mp4`, poster: `${base}/fixtures/clip.png` } },
        "/api/studio/posts/video/summary": { posts: {} },
        "/api/studio/posts/video/list": { videos: [], engines: [], prices: {}, admin: true, access: { admin: true, enabled: true, reason: "" }, billing: "credits" },
        "/api/studio/posts/video/editor/projects": { projects: [], access: { admin: true, enabled: true, reason: "" } },
        "/api/studio/posts/video/audio/list": { tracks: [], access: { admin: true, enabled: true, reason: "" }, generated: { connected: false, reason: "Not connected" } },
        "/api/studio/higgsfield/mcp/status": { signedIn: false, admin: true, switch: { enabled: true }, access: { admin: true, enabled: true, reason: "" }, billing: "credits", billingChosen: true },
        "/api/studio/higgsfield/mcp/models": { models: [], at: NOW },
        "/api/studio/video/presets": { ok: true, category: "popular", categories: [], items: [], nextCursor: null, cachedAt: NOW, cached: true, signedIn: false, admin: true, access: { admin: true, enabled: true, reason: "" }, billing: "credits", reason: "", empty: "Nothing here." },
        "/api/studio/photolab/status": { connected: false, provider: "demo", reason: "No key", prices: {}, approximate: true, access: { admin: true, enabled: true, reason: "" } },
        "/api/studio/freepik/status": { connected: false, demo: true, reason: "No key", admin: true, access: "admin", plan: "unknown", planLabel: "", downloadEstimate: null, entitlements: {}, mcp: { connected: false, url: "" }, switch: { enabled: true, reason: "" } },
        
        "/api/studio/ambassadors": { ambassadors: [] },
        "/api/studio/publish/status": { connected: false },
        "/api/studio/publish": { publications: [] },
        "/api/studio/ocr/status": { connected: false, provider: "none", reason: "Not connected" },
        // What the post editor reads when a tile opens its post.
        "/api/studio/ocr/checks": { checks: [] },
        "/api/studio/feedback": { feedback: [] },
        "/api/studio/photolab/jobs": { jobs: [] },
        "/api/studio/freepik/search": { items: [], page: 1, lastPage: 1, total: 0, demo: true, connected: false, downloadEstimate: null },
      };
      // Lists the brand kit and the panels read on the Studio board: empty, in the shape each one expects.
      if (path.endsWith("/references")) return json({ references: [] });
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
const result = {};

const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
const page = await context.newPage();
page.on("pageerror", (e) => errors.push(`page error: ${String(e)}`));
page.on("console", (m) => m.type() === "error" && !/favicon|404|Failed to load resource/i.test(m.text()) && errors.push(`console error: ${m.text()}`));
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

/** Opens the month on the Studio board. */
async function openStudio() {
  await page.goto(`${url}/?client=c1&month=2026-12`, { waitUntil: "networkidle" });
  const skip = page.getByText("Skip to the Studio").first();
  if (await skip.isVisible().catch(() => false)) await skip.click();
  await page.locator("button.cta", { hasText: "Export" }).first().waitFor({ state: "visible", timeout: 20000 });
}

/** Presses the board's Feed tab and waits for the feed's six tiles. */
async function openFeed() {
  const tab = page.locator(".studio-tabs button", { hasText: /^Feed$/ });
  await tab.click();
  await page.locator(".feed-view .feed-tile").nth(5).waitFor({ state: "visible", timeout: 10000 });
  return tab;
}

/** The tiles pop in one after the other and a dialog fades in: a picture is taken once nothing moves. */
const settled = () => page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running" || a.effect?.getComputedTiming().iterations === Infinity), null, { timeout: 10000 }).catch(() => undefined);

/** "Classic journey" anywhere in the page: its text, its tooltips, its menus. */
const classicLeft = async () => /classic\s+journey/i.test(await page.content());

try {
  await openStudio();
  // The Studio board, with its More menu open: neither the rail nor the menu offers the journey.
  await page.locator(".studio-more-button").click();
  await page.locator(".studio-more .card-menu-list").waitFor({ state: "visible", timeout: 5000 });
  result.moreItems = await page.locator(".studio-more .card-menu-list button").allInnerTexts();
  await page.screenshot({ path: join(outDir, "studio.png") });
  if (await classicLeft()) errors.push('"Classic journey" is still on the Studio board (the rail or the More menu).');
  if (!result.moreItems.some((t) => /Feed PDF/.test(t))) errors.push("The More menu lost its Feed PDF.");
  await page.keyboard.press("Escape");
  await page.locator(".studio-rail").click({ position: { x: 5, y: 5 } });

  const tab = await openFeed();
  result.tabSelected = (await tab.getAttribute("aria-selected")) === "true";
  if (!result.tabSelected) errors.push("The Feed tab did not become the open tab.");
  if ((await page.locator(".journey").count()) > 0) errors.push("The Feed tab opened the workflow's screens instead of a feed.");
  // Every tile shows its picture with the words drawn on (the overlay is drawn by the browser into a data: picture).
  await page
    .waitForFunction(() => {
      const imgs = [...document.querySelectorAll(".feed-view .feed-tile img")];
      return imgs.length === 6 && imgs.every((i) => i.complete && i.naturalWidth > 0 && i.src.startsWith("data:image/"));
    }, null, { timeout: 30000 })
    .catch(() => errors.push("The six tiles did not all show their picture with its words drawn on."));
  const grid = await page.evaluate(() => {
    const tiles = [...document.querySelectorAll(".feed-view .feed-tile")];
    // Their places in the layout: the tiles pop in with a short animation that moves their drawn boxes.
    const boxes = tiles.map((t) => ({ left: t.offsetLeft, top: t.offsetTop, width: t.offsetWidth }));
    const uniq = (list) => [...new Set(list.map((v) => Math.round(v)))].sort((a, b) => a - b);
    return {
      tiles: tiles.length,
      pictures: tiles.filter((t) => t.querySelector("img")?.naturalWidth > 0).length,
      columns: uniq(boxes.map((b) => b.left)).length,
      rows: uniq(boxes.map((b) => b.top)).length,
      tracks: getComputedStyle(document.querySelector(".feed-view .feed-grid")).gridTemplateColumns.split(" ").length,
      order: tiles.map((t) => Number(t.getAttribute("data-post"))),
      width: Math.round(boxes[0]?.width ?? 0),
    };
  });
  Object.assign(result, { grid });
  if (grid.tiles !== 6) errors.push(`The feed shows ${grid.tiles} tiles, not 6.`);
  if (grid.pictures !== 6) errors.push(`The feed shows ${grid.pictures} pictures, not 6.`);
  if (grid.columns !== 3 || grid.tracks !== 3) errors.push(`The feed is ${grid.columns} across (${grid.tracks} grid tracks), not 3.`);
  if (grid.rows !== 2) errors.push(`Six posts sit on ${grid.rows} rows, not 2.`);
  if (grid.order.join(",") !== "6,5,4,3,2,1") errors.push(`The feed is not the newest post first: ${grid.order.join(", ")}.`);
  if (grid.width < 100) errors.push(`The tiles are only ${grid.width}px wide.`);
  await page.locator(".feed-view").scrollIntoViewIfNeeded();
  await settled();
  await page.screenshot({ path: join(outDir, "feed.png") });
  if (await classicLeft()) errors.push('"Classic journey" is still on the page with the Feed tab open.');
  result.classicJourney = await classicLeft();

  // A tile opens its post: the post editor, on that post.
  await page.locator('.feed-view .feed-tile[data-post="3"]').click();
  const editor = page.locator(".review-dialog", { hasText: "Post 3 · Post 3" });
  await editor.waitFor({ state: "visible", timeout: 15000 }).catch(() => errors.push("Clicking the third post's tile did not open that post."));
  result.opened = ((await page.locator(".review-dialog h2").first().textContent().catch(() => "")) ?? "").trim().slice(0, 40);
  await settled();
  await page.screenshot({ path: join(outDir, "post-open.png") });
  await page.keyboard.press("Escape");
  await editor.waitFor({ state: "hidden", timeout: 10000 }).catch(() => errors.push("The post did not close again."));
  result.backOnFeed = (await page.locator(".feed-view .feed-tile").count()) === 6;
  if (!result.backOnFeed) errors.push("Closing the post did not come back to the feed.");

  // A month with no pictures: six empty tiles, each with its post's title; a tile still opens its post.
  empty = true;
  await openStudio();
  await openFeed();
  const blank = await page.evaluate(() => {
    const tiles = [...document.querySelectorAll(".feed-view .feed-tile")];
    return { tiles: tiles.length, pictures: tiles.filter((t) => t.querySelector("img")).length, titles: tiles.map((t) => t.querySelector(".feed-empty small")?.textContent ?? "") };
  });
  Object.assign(result, { empty: blank });
  if (blank.tiles !== 6 || blank.pictures !== 0) errors.push(`A month with no pictures shows ${blank.tiles} tiles and ${blank.pictures} pictures, not 6 and 0.`);
  if (blank.titles.join("|") !== "Post 6|Post 5|Post 4|Post 3|Post 2|Post 1") errors.push(`The empty tiles do not carry their posts' titles: ${blank.titles.join(" | ")}.`);
  await settled();
  await page.screenshot({ path: join(outDir, "feed-empty.png") });
  await page.locator('.feed-view .feed-tile[data-post="2"]').click();
  await page.locator(".review-dialog", { hasText: "Post 2 · Post 2" }).waitFor({ state: "visible", timeout: 15000 }).catch(() => errors.push("An empty tile did not open its post."));
} catch (e) {
  errors.push(`The feed flow stopped: ${e instanceof Error ? e.message : String(e)}`);
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
console.log(`OK · files in ${outDir}`);
