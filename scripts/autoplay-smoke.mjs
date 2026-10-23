/**
 * A browser smoke test of the shared video preview (src/components/AutoplayVideo.tsx) on every
 * surface, in headless Chromium with the built app (dist/client, from `npm run build`) served
 * statically and every API answered by a mock: a month of 14 posts, each with a finished clip.
 *
 * The open-source Chromium Playwright ships plays no H.264, so the clips are a small WebM made
 * here with ffmpeg (into the --out folder, never committed) and served for every clip URL; one
 * clip's preview file is broken (the full file plays instead) and one clip is broken altogether
 * (the Play fallback shows). Nothing reaches a provider; no generation is involved.
 *
 * It checks, at 1440×1000:
 *   - Studio cards: only visible clips play, at most 6 at once; scrolling pauses the ones that leave;
 *   - a person's pause is kept after scrolling away and back and after a re-render (playhead unmoved);
 *   - the sound toggle: one audible clip at a time;
 *   - a background tab (visibilitychange) pauses every clip and they come back after (not the paused one);
 *   - a broken preview falls back to the full file; a broken clip shows "Try again";
 *   - the Video studio: the version stage plays (muted, native controls), the versions list
 *     previews play, the cards behind the studio pause, and the presets gallery plays its visible cards;
 *   - the client link (/share/<token>): the clip plays muted inline with controls and a sound button;
 * and in other contexts:
 *   - reduced motion: nothing plays, each clip shows its poster and a Play button that starts it;
 *   - an iPhone-like 390×844 (isMobile, hasTouch): clips play inline (no fullscreen), no sideways scroll.
 * Screenshots land in --out (default: ./test-results/autoplay).
 *
 * Usage:  npm run build && node scripts/autoplay-smoke.mjs [--out dir]
 */
import { createServer } from "node:http";
import { execFileSync, execSync } from "node:child_process";
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
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const outDir = opt("--out", join(process.cwd(), "test-results", "autoplay"));
await mkdir(outDir, { recursive: true });
const executablePath = process.env.PW_CHROMIUM || "/opt/pw-browsers/chromium";
const dist = join(process.cwd(), "dist", "client");

// A 4-second 360×640 VP8 + Vorbis clip with a moving test pattern and a tone.
const CLIP_FILE = join(outDir, "clip.webm");
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=360x640:rate=24:duration=4", "-f", "lavfi", "-i", "sine=frequency=440:duration=4", "-c:v", "libvpx", "-b:v", "400k", "-c:a", "libvorbis", "-shortest", CLIP_FILE]);
const CLIP = await readFile(CLIP_FILE);
const BROKEN = Buffer.from("this is not a video file at all, just some words".repeat(20));
// A 1×1 grey PNG for every picture and poster.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNoaGgAAAKEAUFkW5o5AAAAAElFTkSuQmCC", "base64");

const NOW = Date.now();
const POSTS = 14;
const TOKEN = "a".repeat(32);
const ADMIN = { id: "u1", email: "smoke@example.test", name: "Smoke", role: "admin" };
const CLIENT = { id: "c1", slug: "habibah", name: "Habibah", logo: false, badge: false, colors: [{ name: "Pistachio", hex: "#8fbf6a" }], fonts: {}, tone: "", dos: "", donts: "", style: "", gridRhythm: "", language: "en", status: "active", position: 0, batches: 1, updated: NOW, overlay: null, fontFiles: [], places: [] };
const plan = Array.from({ length: POSTS }, (_, i) => ({ index: i + 1, type: "offer", title: `Post ${i + 1}`, brief: "The pistachio kunafa on marble.", caption: "", hashtags: "", product: "pistachio", headline: `Post ${i + 1}`, subline: "This week only", ideaAt: 1, overlay: false }));
const CONFIG = { mode: "post", input: "model", prompt: "", ratio: "4:5", size: "1K", count: 1, backdrop: "", market: "auto", skill: "editorial", economy: false, output: "jpg", outputQuality: 90, outputSize: "fit", colors: "", modelDescription: "", center: true, client: "c1", month: "2026-10", postCount: POSTS, format: "4:5", model: "nano-banana-pro", plan, plannedAt: 1, shareToken: TOKEN };
const BATCH = { id: "b1", name: "Habibah · October 2026", config: JSON.stringify(CONFIG), client: "c1", month: "2026-10", theme: null, state: "idle", last_error: null, created: NOW, updated: NOW };
const TASKS = plan.map((p) => ({ id: `t${p.index}`, source: "s1", card: p.index, status: "ready", output: `u1/b1/output/t${p.index}/a.png`, qa: JSON.stringify({ automated: true, flags: [], notes: "Looks right.", found: true, count: 1, box: [], productConcern: false, centered: true }), error: null, prompt: "", attempts: 1, request_id: null, brief: null, cost: 0.04, updated: NOW, post: p.index, made_for: 1 }));
const SOURCE = { id: "s1", name: "pistachio.jpg", mime: "image/jpeg", size: 1000, role: "lead", kind: "product", created: NOW };

/** A finished clip as server/video.ts answers it. Post 3's preview is broken (the full file plays); post 5 is broken altogether. */
const clip = (post, version = 1, extra = {}) => {
  const id = `v${post}-${version}`;
  const q = `batch=b1&id=${id}`;
  return { id, post, model: "upload", provider: "upload", source: "upload", prompt: "", status: "done", error: null, created: NOW - version * 1000, updated: NOW, duration: 4, aspect: "9:16", resolution: null, estimate: 0, forClient: version === 1, requestId: null, url: `/api/studio/posts/video/file?${q}`, poster: `/api/studio/posts/video/poster?${q}`, preview: post % 2 === 0 || post === 3 ? `/api/studio/posts/video/preview?${q}` : null, version, warnings: [], audioChoice: null, audioId: null, audioName: null, label: null, check: null, analysis: null, frame: "9:16", frameFill: null, words: null, ...extra };
};
const SUMMARY = Object.fromEntries(plan.map((p) => [String(p.index), { latest: clip(p.index), client: clip(p.index), done: clip(p.index) }]));
const presetCard = (id, title) => ({ id, source: "marketing_studio", title, description: `${title}: what the preset does.`, command: `/${id}`, category: "product-shot", type: "product", video: `/fixtures/preset-${id}.mp4`, poster: `/fixtures/preset-${id}.png`, price: 20, needs: ["1 product picture"], runnable: true, engine: null, prompt: `A ${title.toLowerCase()}`, output: "video" });
const PRESETS = Array.from({ length: 12 }, (_, i) => presetCard(`p${i + 1}`, `Preset ${i + 1}`));
const CATEGORIES = [{ id: "popular", label: "Popular", hint: "What Higgsfield shows first." }];

const SHARED = {
  client: { name: "Habibah", overlay: null, logo: false, badge: false, fonts: [], updated: NOW, instagram: null },
  month: "2026-10",
  posts: plan.slice(0, 8).map((p) => ({ video: { id: `v${p.index}-1`, url: `/api/share/${TOKEN}/video/${p.index}?v=1`, poster: `/api/share/${TOKEN}/video/${p.index}/poster?v=1`, duration: 4, version: { kind: "video", id: `v${p.index}-1`, label: "Video 1" } }, version: { kind: "video", id: `v${p.index}-1`, label: "Video 1" }, index: p.index, date: null, headline: p.headline, subline: p.subline, overlay: false, ov: null, caption: "A caption.", hashtags: "", image: 1, approval: null })),
};

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".woff2": "font/woff2", ".json": "application/json", ".ico": "image/x-icon" };

/** Serves `bytes` as a WebM with Range, the way R2 answers through server/range.ts. */
function sendMedia(req, res, bytes, type = "video/webm") {
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
  if (!m) {
    res.writeHead(200, { "content-type": type, "content-length": bytes.length, "accept-ranges": "bytes", "cache-control": "no-store" });
    res.end(req.method === "HEAD" ? undefined : bytes);
    return;
  }
  const start = m[1] ? Number(m[1]) : Math.max(0, bytes.length - Number(m[2]));
  const end = m[1] && m[2] ? Math.min(Number(m[2]), bytes.length - 1) : bytes.length - 1;
  res.writeHead(206, { "content-type": type, "content-length": end - start + 1, "content-range": `bytes ${start}-${end}/${bytes.length}`, "accept-ranges": "bytes", "cache-control": "no-store" });
  res.end(req.method === "HEAD" ? undefined : bytes.subarray(start, end + 1));
}

const mediaHits = [];
const generationCalls = [];
/** What the stage's "make a preview later" sent: which parts (this Chromium has no H.264 encoder, so a still only). */
const renditionPosts = [];

async function startServer() {
  const server = createServer(async (req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    const path = decodeURIComponent(u.pathname);
    // Every clip, preview and preset reference: the WebM (post 3's preview and post 5's file are broken).
    const isClip = req.method !== "POST" && (path === "/api/studio/posts/video/file" || path === "/api/studio/posts/video/preview" || /^\/api\/share\/[0-9a-f]{32}\/video\/\d+$/.test(path) || (path.startsWith("/fixtures/") && path.endsWith(".mp4")));
    if (isClip) {
      mediaHits.push(`${path}?${u.searchParams.toString()}`);
      const id = u.searchParams.get("id") ?? "";
      const broken = (path.endsWith("/preview") && id === "v3-1") || (path.endsWith("/file") && id === "v5-1");
      if (broken) {
        res.writeHead(200, { "content-type": "video/mp4", "content-length": BROKEN.length });
        res.end(BROKEN);
        return;
      }
      sendMedia(req, res, CLIP);
      return;
    }
    if (path.startsWith("/fixtures/") || path.endsWith("/poster") || path === "/api/studio/file" || /^\/api\/share\/[0-9a-f]{32}\/(image|subject)\//.test(path)) {
      res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" });
      res.end(PNG);
      return;
    }
    if (path.startsWith("/api/")) {
      // Any generation route reached by mistake is recorded and fails the run.
      if (req.method === "POST" && /(\/posts\/video$|\/retry$|\/run$|generate|\/enhance$|\/tool$|\/check$)/.test(path)) generationCalls.push(path);
      const index = Number(u.searchParams.get("index") ?? 1);
      const MOCK = {
        "/api/auth/me": { user: ADMIN, registrationOpen: false },
        "/api/studio/state": { user: ADMIN, batches: [BATCH], trash: [], spend: [], spendThreshold: 20, clients: [CLIENT], engine: { model: "nano-banana-pro", configured: false, source: "none", openai: "none", google: "none", fal: "none", review: false, vertex: null }, preview: true, workflowV2: true },
        "/api/studio/batch": { batch: BATCH, sources: [SOURCE], tasks: TASKS },
        "/api/studio/engine/models": { models: [] },
        "/api/studio/styles/pending": { n: 0 },
        "/api/studio/lessons/pending": { n: 0 },
        "/api/studio/posts/themes": { themes: [] },
        "/api/studio/posts/takes": { takes: [] },
        "/api/studio/posts/versions": { versions: [] },
        "/api/studio/posts/video/summary": { posts: SUMMARY },
        "/api/studio/posts/video/list": { videos: [clip(index, 1), clip(index, 2, { forClient: false }), clip(index, 3, { forClient: false }), clip(index, 4, { forClient: false })], engines: [], prices: {}, admin: true, access: { admin: true, enabled: true, reason: "" }, billing: "credits" },
        "/api/studio/posts/video/editor/projects": { projects: [], access: { admin: true, enabled: true, reason: "" } },
        "/api/studio/posts/video/audio/list": { tracks: [], access: { admin: true, enabled: true, reason: "" }, generated: { connected: false, reason: "Not connected" } },
        "/api/studio/higgsfield/mcp/status": { signedIn: true, email: "owner@test", signedInAt: NOW, plan: "Creator", credits: 1500, creditsAt: NOW, balanceError: "", billing: "credits", billingChosen: true, cloudConfigured: false, admin: true, switch: { enabled: true }, access: { admin: true, enabled: true, reason: "" }, url: "https://mcp.higgsfield.ai/mcp", device: null },
        "/api/studio/higgsfield/mcp/models": { models: [], at: NOW },
        "/api/studio/video/presets": { ok: true, category: "popular", categories: CATEGORIES, items: PRESETS, nextCursor: null, cachedAt: NOW, cached: true, signedIn: true, admin: true, access: { admin: true, enabled: true, reason: "" }, billing: "credits", reason: "", empty: "Nothing here yet." },
        "/api/studio/video/magnific/status": { ok: true, connected: false, source: null, admin: true, access: { admin: true, enabled: true, reason: "" }, tools: [], reason: "Not connected." },
        "/api/studio/video/higgsfield/tools": { ok: true, signedIn: true, billing: "credits", admin: true, access: { admin: true, enabled: true, reason: "" }, reason: "", available: {}, tools: [], checks: [] },
        "/api/studio/photolab/status": { connected: false, provider: "demo", reason: "No key", prices: {}, approximate: true, access: { admin: true, enabled: true, reason: "" } },
        "/api/studio/freepik/status": { connected: false, demo: true, reason: "No key", admin: true, access: "admin", plan: "unknown", planLabel: "", downloadEstimate: null, entitlements: {}, mcp: { connected: false, url: "" }, switch: { enabled: true, reason: "" } },
        "/api/studio/drive/c1": { groups: { product: [], reference: [] }, photos: [], missing: [], demo: true },
        "/api/studio/ambassadors": { ambassadors: [] },
        "/api/studio/publish/status": { connected: false },
        "/api/studio/publish": { publications: [] },
        "/api/studio/ocr/status": { connected: false, provider: "none", reason: "Not connected" },
        [`/api/share/${TOKEN}`]: SHARED,
      };
      // The "make a preview later" route answers as the server does without storing anything.
      if (path === "/api/studio/posts/video/preview" && req.method === "POST") {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const body = Buffer.concat(chunks).toString("latin1");
        renditionPosts.push({ still: body.includes('name="still"'), preview: body.includes('name="preview"'), id: /name="id"\r\n\r\n([^\r]*)/.exec(body)?.[1] ?? null });
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "smoke: not stored" }));
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

const served = await startServer();
const url = served.url;
// The browser's own autoplay policy (muted inline autoplay allowed, sound only after a gesture) is kept.
const browser = await chromium.launch({ executablePath, headless: true });
const errors = [];
const result = {};
const check = (ok, message) => {
  if (!ok) errors.push(message);
  return ok;
};

async function newPage(options = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, ...options });
  await context.addInitScript(() => {
    try {
      sessionStorage.setItem("lsm-journey-done", "1");
      localStorage.setItem("lsm-journey-done", "1");
      localStorage.setItem("lsm-client", "c1");
    } catch {
      /* storage blocked */
    }
  });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(`page error: ${String(e)}`));
  if (process.env.SMOKE_DEBUG) page.on("console", (m) => console.log(`[console.${m.type()}] ${m.text()}`));
  page.on("request", (r) => {
    const u = r.url();
    if (![url, "data:", "blob:", "https://fonts.googleapis.com/", "https://fonts.gstatic.com/"].some((a) => u.startsWith(a))) errors.push(`network call outside the test server: ${u}`);
  });
  return { context, page };
}

/** Every shared preview on the page: which clip, playing or not, how much is on screen, muted, its time. */
const states = (page, selector = ".apv video") =>
  page.locator(selector).evaluateAll((els) =>
    els.map((v) => {
      const r = v.getBoundingClientRect();
      const visH = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
      const visW = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0));
      const share = r.width && r.height ? (visH * visW) / (r.width * r.height) : 0;
      return { label: v.getAttribute("aria-label"), playing: !v.paused && !v.ended, muted: v.muted, share: Math.round(share * 100) / 100, time: v.currentTime, src: v.currentSrc, failed: !!v.closest(".apv")?.classList.contains("is-failed") };
    }),
  );
const settle = (page, ms = 1500) => page.waitForTimeout(ms);
const openStudio = async (page) => {
  await page.goto(`${url}/?client=c1&month=2026-10`, { waitUntil: "networkidle" });
  await page.locator(".pc-video-preview").first().waitFor({ state: "attached", timeout: 20000 });
  await settle(page, 2000);
};

try {
  /* ───────────── 1440 × 1000: the Studio cards ───────────── */
  {
    const { context, page } = await newPage();
    await openStudio(page);
    let s = await states(page, ".pc-video-preview video");
    result.cards = s.length;
    check(s.length === POSTS, `Every post with a clip should show it on its card: ${s.length} of ${POSTS}`);
    const playing = s.filter((x) => x.playing);
    result.cardsPlayingAtTop = playing.map((x) => x.label);
    check(playing.length > 0, "Some visible card clips should play by themselves");
    check(playing.length <= 6, `At most 6 clips should play at once, found ${playing.length}`);
    check(playing.every((x) => x.share >= 0.3), `Only clips on screen should play: ${JSON.stringify(playing)}`);
    check(s.every((x) => x.muted), "Every card clip should start muted");
    const visibleCount = s.filter((x) => x.share >= 0.35 && !x.failed).length;
    result.cardsVisibleAtTop = visibleCount;
    if (visibleCount > 6) check(playing.length === 6, `With ${visibleCount} on screen, 6 should play, found ${playing.length}`);
    // Lightweight previews: posts with one play the preview file; post 3's broken preview falls back to the full file.
    const post2 = s.find((x) => /^Post 2 /.test(x.label ?? ""));
    check(!!post2 && /\/preview\?/.test(post2.src), `Post 2 should play its lightweight preview, got ${post2?.src}`);
    const post3 = s.find((x) => /^Post 3 /.test(x.label ?? ""));
    check(!!post3 && /\/file\?/.test(post3.src) && !post3.failed, `Post 3's broken preview should fall back to the full file, got ${JSON.stringify(post3)}`);
    // Post 5's clip is broken: its card shows "Try again" over the poster, not a black box.
    const post5 = s.find((x) => /^Post 5 /.test(x.label ?? ""));
    check(!!post5?.failed, `Post 5's broken clip should show the Play fallback, got ${JSON.stringify(post5)}`);
    result.tryAgainButtons = await page.getByRole("button", { name: /^Try Post 5 .* again$/ }).count();
    check(result.tryAgainButtons === 1, "Post 5 should offer a 'Try again' button");
    // The far cards have not fetched their file (lazy src).
    result.cardsWithoutSrc = await page.locator(".pc-video-preview video:not([src])").count();
    check(result.cardsWithoutSrc > 0, "Cards far below the screen should not have loaded their clip yet");
    await page.screenshot({ path: join(outDir, "cards-1440.png") });
    // A taller window shows more cards than the cap: exactly 6 play, the most visible.
    await page.setViewportSize({ width: 1440, height: 2600 });
    await settle(page, 2000);
    s = await states(page, ".pc-video-preview video");
    result.tallOnScreen = s.filter((x) => x.share >= 0.35 && !x.failed).length;
    result.tallPlaying = s.filter((x) => x.playing).length;
    check(result.tallOnScreen > 6, `The tall window should show more than 6 clips, found ${result.tallOnScreen}`);
    check(result.tallPlaying === 6, `With ${result.tallOnScreen} clips on screen exactly 6 should play, found ${result.tallPlaying}`);
    await page.screenshot({ path: join(outDir, "cards-1440x2600-cap.png") });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await settle(page);
    s = await states(page, ".pc-video-preview video");

    // Scrolling: the clips that leave the screen pause; the new ones play.
    const before = new Set(playing.map((x) => x.label));
    await page.mouse.wheel(0, 1600);
    await settle(page);
    s = await states(page, ".pc-video-preview video");
    const left = s.filter((x) => before.has(x.label) && x.share < 0.05);
    result.leftAfterScroll = left.map((x) => [x.label, x.playing]);
    check(left.length > 0, "Scrolling 1600 px should move some playing clips off screen");
    check(left.every((x) => !x.playing), `Clips that left the screen should pause: ${JSON.stringify(left)}`);
    const nowPlaying = s.filter((x) => x.playing);
    check(nowPlaying.length > 0 && nowPlaying.length <= 6 && nowPlaying.every((x) => x.share >= 0.3), `After scrolling, only the clips on screen should play (≤ 6): ${JSON.stringify(nowPlaying)}`);
    await page.screenshot({ path: join(outDir, "cards-1440-scrolled.png") });

    // A person's pause wins: kept after scrolling away and back and after a re-render, the playhead unmoved.
    await page.mouse.wheel(0, -4000);
    await settle(page);
    s = await states(page, ".pc-video-preview video");
    const target = s.find((x) => x.playing);
    check(!!target, "A clip should play at the top to test the pause");
    if (target) {
      const card = page.locator(".pc-video-preview", { has: page.locator(`video[aria-label="${target.label}"]`) });
      await card.hover();
      await card.getByRole("button", { name: `Pause ${target.label}` }).click();
      await settle(page, 500);
      const paused = (await states(page, ".pc-video-preview video")).find((x) => x.label === target.label);
      check(!paused.playing, "The Pause button should pause the clip");
      await page.mouse.wheel(0, 2400);
      await settle(page, 800);
      await page.mouse.wheel(0, -2400);
      await settle(page, 800);
      await page.setViewportSize({ width: 1400, height: 1000 });
      await settle(page, 600);
      await page.setViewportSize({ width: 1440, height: 1000 });
      await settle(page, 1000);
      const after = (await states(page, ".pc-video-preview video")).find((x) => x.label === target.label);
      result.pausedKept = !after.playing;
      result.playheadKept = Math.abs(after.time - paused.time) < 0.01;
      check(result.pausedKept, "A clip the person paused should stay paused after scrolling away and back and a re-render");
      check(result.playheadKept, `The playhead of a paused clip should not move (${paused.time} → ${after.time})`);
      await page.screenshot({ path: join(outDir, "cards-1440-paused.png") });

      // Sound: one audible clip at a time.
      const others = (await states(page, ".pc-video-preview video")).filter((x) => x.playing && x.label !== target.label);
      check(others.length >= 2, "Two playing clips are needed for the sound test");
      const [a, b] = others;
      const cardA = page.locator(".pc-video-preview", { has: page.locator(`video[aria-label="${a.label}"]`) });
      const cardB = page.locator(".pc-video-preview", { has: page.locator(`video[aria-label="${b.label}"]`) });
      await cardA.hover();
      await cardA.getByRole("button", { name: `Sound on for ${a.label}` }).click();
      await settle(page, 300);
      let snd = await states(page, ".pc-video-preview video");
      check(snd.find((x) => x.label === a.label)?.muted === false, "Sound on should unmute the clip");
      await cardB.hover();
      await cardB.getByRole("button", { name: `Sound on for ${b.label}` }).click();
      await settle(page, 300);
      snd = await states(page, ".pc-video-preview video");
      result.audible = snd.filter((x) => !x.muted).map((x) => x.label);
      check(result.audible.length === 1 && result.audible[0] === b.label, `Only the last clip given sound should be audible: ${JSON.stringify(result.audible)}`);

      // A background tab pauses everything; back in front, the clips play again, except the one the person paused.
      await page.evaluate(() => {
        Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
        Object.defineProperty(document, "hidden", { value: true, configurable: true });
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await settle(page, 600);
      result.playingInBackground = (await states(page, ".pc-video-preview video")).filter((x) => x.playing).length;
      check(result.playingInBackground === 0, `A background tab should pause every clip, ${result.playingInBackground} kept playing`);
      await page.evaluate(() => {
        Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
        Object.defineProperty(document, "hidden", { value: false, configurable: true });
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await settle(page, 1000);
      const back = await states(page, ".pc-video-preview video");
      result.playingBackInFront = back.filter((x) => x.playing).length;
      check(result.playingBackInFront > 0, "Back in front, the clips should play again");
      check(!back.find((x) => x.label === target.label)?.playing, "Back in front, the clip the person paused should stay paused");
    }

    /* ───────────── The Video studio: version stage, versions list, presets ───────────── */
    await page.getByRole("button", { name: /^Video studio$/ }).first().click();
    const studio = page.locator('[role="dialog"][aria-label="Video studio"]');
    await studio.waitFor({ state: "visible", timeout: 20000 });
    await studio.locator(".vs-frame .apv video").first().waitFor({ state: "attached", timeout: 20000 });
    await settle(page, 2000);
    const stage = await states(page, ".vs-frame .apv video");
    result.stage = stage;
    check(stage.length === 1 && stage[0].playing, `The version stage should play the shown clip by itself: ${JSON.stringify(stage)}`);
    check(stage[0]?.muted === true, "The version stage should start muted");
    result.stageControls = await studio.locator(".vs-frame video[controls]").count();
    check(result.stageControls === 1, "The version stage should keep the browser's controls (seek, volume, fullscreen)");
    result.stageSound = await studio.locator(".vs-frame .apv-tools button[aria-label^='Sound on']").count();
    check(result.stageSound === 1, "The version stage should show the sound button");
    const behind = (await states(page, ".pc-video-preview video")).filter((x) => x.playing);
    result.cardsPlayingBehindStudio = behind.length;
    check(behind.length === 0, `The cards behind the Video studio should pause, ${behind.length} kept playing`);
    await page.screenshot({ path: join(outDir, "studio-1440-stage.png") });
    // An admin keeps the clip on the stage a few seconds: its lightweight versions are made here (a still only in this Chromium).
    await settle(page, 4000);
    // Versions: the list's previews play too.
    await studio.locator(".vs-rail button", { hasText: "Versions" }).click();
    await studio.locator(".vs-list .vs-clip video").first().waitFor({ state: "attached", timeout: 10000 });
    await settle(page, 1500);
    const listClips = await states(page, ".vs-list .vs-clip video");
    result.versionsListPlaying = listClips.filter((x) => x.playing).length;
    check(listClips.length === 4 && result.versionsListPlaying >= 1, `The versions list should show its clips playing: ${JSON.stringify(listClips)}`);
    check((await states(page, ".apv video")).filter((x) => x.playing).length <= 6, "The Video studio should keep to the 6-clip cap");
    await page.screenshot({ path: join(outDir, "studio-1440-versions.png") });
    // Presets: the visible cards play by themselves (no hover), at most six.
    await studio.locator(".vs-rail button", { hasText: "Presets" }).click();
    await studio.locator(".vs-preset .apv video").first().waitFor({ state: "attached", timeout: 10000 });
    await settle(page, 2000);
    const presets = await states(page, ".vs-preset .apv video");
    result.presetCards = presets.length;
    result.presetsPlaying = presets.filter((x) => x.playing).length;
    result.presetsOnScreen = presets.filter((x) => x.share >= 0.35).length;
    if (result.presetsOnScreen > 6) check(result.presetsPlaying === 6, `With ${result.presetsOnScreen} presets on screen, exactly 6 should play, found ${result.presetsPlaying}`);
    check(presets.length === PRESETS.length, `The gallery should show ${PRESETS.length} preset videos, found ${presets.length}`);
    check(result.presetsPlaying >= 1 && result.presetsPlaying <= 6, `The gallery's visible presets should play (≤ 6), ${result.presetsPlaying} play`);
    check(presets.filter((x) => x.playing).every((x) => x.share >= 0.3), "Only the presets on screen should play");
    // A tap on a preset's video opens its detail, where it plays large with controls.
    await studio.getByRole("button", { name: "Preset 1: open" }).click();
    await studio.locator(".vs-detail-media .apv video").waitFor({ state: "attached", timeout: 10000 });
    await settle(page, 1500);
    const detail = await states(page, ".vs-detail-media .apv video");
    check(detail[0]?.playing === true && detail[0]?.muted === true, `The preset detail should play muted: ${JSON.stringify(detail)}`);
    await page.screenshot({ path: join(outDir, "studio-1440-presets.png") });
    // Closing the studio: its clips are gone and the cards play again.
    await studio.getByRole("button", { name: "Close" }).first().click();
    await studio.waitFor({ state: "detached", timeout: 10000 });
    await settle(page, 1500);
    result.cardsPlayingAfterStudio = (await states(page, ".pc-video-preview video")).filter((x) => x.playing).length;
    check(result.cardsPlayingAfterStudio > 0, "After the studio closes, the cards should play again");
    await context.close();
  }

  /* ───────────── The client link ───────────── */
  {
    const { context, page } = await newPage();
    await page.goto(`${url}/share/${TOKEN}`, { waitUntil: "networkidle" });
    await page.locator(".share-media .apv video").first().waitFor({ state: "attached", timeout: 20000 });
    await page.locator(".share-media").first().scrollIntoViewIfNeeded();
    await settle(page, 2000);
    const s = await states(page, ".share-media .apv video");
    result.shareClips = s.length;
    result.sharePlaying = s.filter((x) => x.playing).length;
    check(s.length === 8, `The client link should show 8 clips, found ${s.length}`);
    check(result.sharePlaying >= 1 && result.sharePlaying <= 6, `The client's visible clip should play by itself (≤ 6), ${result.sharePlaying} play`);
    check(s.every((x) => x.muted), "The client's clips should start muted");
    check((await page.locator(".share-media video[controls]").count()) === 8, "The client's clips should keep the browser's controls");
    const first = s.find((x) => x.playing);
    if (first) {
      await page.getByRole("button", { name: `Sound on for ${first.label}` }).click();
      await settle(page, 300);
      check((await states(page, ".share-media .apv video")).find((x) => x.label === first.label)?.muted === false, "The client's sound button should unmute the clip");
    }
    await page.screenshot({ path: join(outDir, "share-1440.png") });
    await context.close();
  }

  /* ───────────── Reduced motion: posters and a Play button ───────────── */
  {
    const { context, page } = await newPage({ reducedMotion: "reduce" });
    await openStudio(page);
    const s = await states(page, ".pc-video-preview video");
    result.reducedPlaying = s.filter((x) => x.playing).length;
    check(result.reducedPlaying === 0, `Under reduced motion nothing should play by itself, ${result.reducedPlaying} play`);
    const plays = page.getByRole("button", { name: /^Play Post \d+ / });
    result.reducedPlayButtons = await plays.count();
    check(result.reducedPlayButtons >= 1, "Under reduced motion each clip should offer a Play button");
    result.reducedPlayText = (await page.locator(".apv-play span").first().innerText()).trim();
    check(/reduced motion/i.test(result.reducedPlayText), `The Play button should say why, got "${result.reducedPlayText}"`);
    await page.screenshot({ path: join(outDir, "cards-1440-reduced-motion.png") });
    const label = (await plays.first().getAttribute("aria-label")).replace(/^Play /, "");
    await plays.first().click();
    await settle(page, 800);
    result.reducedStartedByHand = (await states(page, ".pc-video-preview video")).find((x) => x.label === label)?.playing === true;
    check(result.reducedStartedByHand, "Under reduced motion, Play should start the clip");
    await context.close();
  }

  /* ───────────── An iPhone-like 390 × 844 ───────────── */
  {
    const { context, page } = await newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1" });
    await openStudio(page);
    // The first card sits below the month's header on a phone: scroll to it.
    await page.locator(".pc-video-preview").first().evaluate((el) => el.scrollIntoView({ block: "center" }));
    await settle(page, 2000);
    let s = await states(page, ".pc-video-preview video");
    result.mobilePlaying = s.filter((x) => x.playing).length;
    check(result.mobilePlaying >= 1, "On a phone, the visible card clip should play by itself");
    check(s.filter((x) => x.playing).every((x) => x.share >= 0.3), "On a phone, only the clips on screen should play");
    result.mobileInline = await page.evaluate(() => [...document.querySelectorAll(".apv video")].every((v) => v.playsInline && v.hasAttribute("playsinline") && v.hasAttribute("webkit-playsinline") && v.hasAttribute("muted")) && !document.fullscreenElement);
    check(result.mobileInline, "On a phone, clips should play inline (playsinline, muted attribute) and never go fullscreen by themselves");
    check(!(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)), "The Studio scrolls sideways at 390 px");
    await page.screenshot({ path: join(outDir, "cards-390.png") });
    await page.goto(`${url}/share/${TOKEN}`, { waitUntil: "networkidle" });
    await page.locator(".share-media .apv video").first().waitFor({ state: "attached", timeout: 20000 });
    await page.locator(".share-media").first().scrollIntoViewIfNeeded();
    await settle(page, 2000);
    s = await states(page, ".share-media .apv video");
    result.mobileSharePlaying = s.filter((x) => x.playing).length;
    check(result.mobileSharePlaying >= 1, "On a phone, the client's visible clip should play by itself");
    check(!(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)), "The client link scrolls sideways at 390 px");
    await page.screenshot({ path: join(outDir, "share-390.png") });
    await context.close();
  }
} catch (e) {
  errors.push(`The flow stopped: ${e instanceof Error ? e.message : String(e)}`);
}

result.mediaRequests = mediaHits.length;
result.renditionPosts = renditionPosts;
check(renditionPosts.some((r) => r.still && r.id === "v1-1"), "The stage should have made and sent a still for the shown clip that had no preview (admins)");
if (generationCalls.length) errors.push(`Generation routes were called: ${generationCalls.join(", ")}`);
console.log(JSON.stringify(result, null, 2));
await browser.close();
served.server.close();
if (errors.length) {
  console.error("FAILED:\n- " + errors.join("\n- "));
  process.exit(1);
}
console.log(`OK · screenshots in ${outDir}`);
