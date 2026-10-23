/**
 * A browser smoke test of the video editor's standalone screen in headless Chromium: the built
 * app (dist/client, from `npm run build`) is served statically with the few API calls the studio
 * makes at boot answered by a mock (a signed-in admin, no months, no clients), the page opens at
 * /video-editor, the editor mounts, and the capability check answers honestly.
 *
 * Open-source Chromium (the Playwright one at /opt/pw-browsers/chromium) has no H.264 decoder or
 * encoder and no AAC, so here the expected outcome is the stop message ("Use Chrome, Edge or
 * Safari on a computer"); on a branded Chrome the editor opens with an empty timeline instead,
 * and where that Chrome has H.264 but no AAC encoder (Chrome on Linux) the Render panel shows the
 * AAC fallback's note instead of a stop (PW_CHROMIUM=<chrome binary> to run it there).
 * Either way the page must raise no uncaught error and make no network call outside the server.
 * No Worker, no D1 and no wrangler are involved: the mock is in this file.
 *
 * Usage:  npm run build && node scripts/video-editor-smoke.mjs [--url http://host:port]
 * With --url the script skips its own server and mock and tests a running studio (signed in
 * already, or with --sign-in email:password).
 */
import { createServer } from "node:http";
import { execSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { pathToFileURL } from "node:url";

/** Playwright from the project when installed, else from the global npm root (this sandbox has it there). */
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
const externalUrl = (opt("--url", "") || "").replace(/\/$/, "");
const signIn = opt("--sign-in", "");
const executablePath = process.env.PW_CHROMIUM || "/opt/pw-browsers/chromium";
const dist = join(process.cwd(), "dist", "client");

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".woff2": "font/woff2", ".json": "application/json", ".ico": "image/x-icon" };
const ADMIN = { id: "smoke-admin", email: "smoke@example.test", name: "Smoke", role: "admin" };
const MOCK = {
  "/api/auth/me": { user: ADMIN, registrationOpen: false },
  "/api/studio/state": {
    user: ADMIN,
    batches: [],
    trash: [],
    spend: [],
    spendThreshold: 20,
    clients: [],
    engine: { model: "nano-banana-pro", configured: false, source: "none", openai: "none", google: "none", fal: "none", review: false, vertex: null },
    preview: true,
  },
  "/api/studio/engine/models": { models: [] },
  "/api/studio/styles/pending": { n: 0 },
  "/api/studio/lessons/pending": { n: 0 },
};

/** The built app, statically; /api/* from the mock above ({} for anything else, 404 never). */
async function startStatic() {
  const server = createServer(async (req, res) => {
    const path = decodeURIComponent((req.url ?? "/").split("?")[0]);
    if (path.startsWith("/api/")) {
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

const served = externalUrl ? null : await startStatic();
const url = externalUrl || served.url;
const browser = await chromium.launch({ executablePath, headless: true, args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errors = [];
const outside = [];
page.on("pageerror", (e) => errors.push(`page error: ${String(e)}`));
// The studio's index.html loads its fonts from Google Fonts; that is the one outside host allowed.
const ALLOWED = [url, "data:", "blob:", "https://fonts.googleapis.com/", "https://fonts.gstatic.com/"];
page.on("request", (r) => {
  const u = r.url();
  if (!ALLOWED.some((a) => u.startsWith(a))) outside.push(u);
});

// WebCodecs exists only in a secure context, so the question is asked on the served page, not on about:blank.
await page.goto(`${url}/`, { waitUntil: "domcontentloaded" });
const codecs = await page.evaluate(async () => {
  const out = { webcodecs: typeof VideoEncoder !== "undefined", h264: false, aac: false, h264decode: false };
  if (!out.webcodecs) return out;
  const ask = async (fn) => {
    try {
      return !!(await fn()).supported;
    } catch {
      return false;
    }
  };
  out.h264 = await ask(() => VideoEncoder.isConfigSupported({ codec: "avc1.640028", width: 1080, height: 1920, bitrate: 8e6, avc: { format: "avc" } }));
  out.aac = await ask(() => AudioEncoder.isConfigSupported({ codec: "mp4a.40.2", sampleRate: 48000, numberOfChannels: 2, bitrate: 128000 }));
  out.h264decode = await ask(() => VideoDecoder.isConfigSupported({ codec: "avc1.640028" }));
  return out;
});
console.log("codecs in this browser:", JSON.stringify(codecs));

await page.goto(`${url}/video-editor`, { waitUntil: "networkidle" });
if (signIn) {
  const [email, password] = signIn.split(":");
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForLoadState("networkidle");
  await page.goto(`${url}/video-editor`, { waitUntil: "networkidle" });
}

const editor = page.locator('[role="dialog"][aria-label="Video editor"]');
const mounted = await editor.waitFor({ state: "visible", timeout: 20000 }).then(() => true, () => false);
let result;
if (!mounted) {
  result = { mounted: false, note: "The editor did not mount (a sign-in gate? pass --sign-in email:password when testing a running studio)." };
  errors.push("The editor did not mount at /video-editor.");
} else {
  // The capability check runs after mount; give it a moment to answer.
  await page.waitForTimeout(1500);
  const stops = editor.locator(".ve-stop");
  const stopText = (await stops.count()) ? (await stops.first().innerText()).trim() : "";
  // H.264 without AAC renders through the editor's WebAssembly AAC encoder (a note, not a stop).
  const expectStop = !(codecs.h264 && codecs.h264decode);
  const expectFallback = !expectStop && !codecs.aac;
  // The standalone editor is the Video studio's Edit tool alone: one tool on the phone's bottom toolbar, the five tabs inside its panel.
  const bottomTabs = await editor.locator(".vs-bottom button").count();
  const editTabs = await editor.locator(".vs-tabs button").count();
  const title = (await editor.locator(".ts-title").innerText()).trim();
  // Open the Render tab (it was Export): on a phone one panel shows at a time, under the preview.
  await editor.locator(".vs-tabs button", { hasText: "Render" }).click();
  const exportPanelStop = (await editor.locator(".ts-side-body .ve-stop").count()) > 0;
  const exportButton = await editor.locator(".ts-side-body .ts-btn.primary").count();
  const hints = await editor.locator(".ts-side-body .ts-hint").allInnerTexts();
  const fallbackNote = hints.find((h) => /no built-in AAC audio encoder/.test(h)) ?? null;
  result = { mounted: true, title, stopMessage: stopText || null, expectedStop: expectStop, expectedFallback: expectFallback, fallbackNote, narrowToolbarTabs: bottomTabs, editTabs, exportPanelStop, exportButton };
  if (expectFallback && !fallbackNote) errors.push("This browser has H.264 but no AAC encoder: the Render panel should say the editor encodes the sound itself.");
  if (!expectFallback && fallbackNote) errors.push(`The AAC fallback note appeared although it does not apply here: ${fallbackNote}`);
  if (expectStop && !/Use Chrome, Edge or Safari on a computer/.test(stopText)) errors.push("The capability message was expected (no H.264/AAC here) and was not shown.");
  if (expectStop && !exportPanelStop) errors.push("The Render panel should show the stop message instead of the Export button.");
  if (!expectStop && stopText) errors.push(`A stop message appeared although the browser can render (H.264, and AAC natively or through the fallback): ${stopText}`);
  if (!expectStop && exportButton !== 1) errors.push("The Render panel should show the Render button on a capable browser.");
  if (bottomTabs !== 1) errors.push(`The 390 px bottom toolbar should show the one Edit tool with no post open, found ${bottomTabs}.`);
  if (editTabs !== 7) errors.push(`The Edit panel should show its 7 tabs (Media, Text, Logo, Music, Colour, Auto edit, Render), found ${editTabs}.`);
}
console.log(JSON.stringify(result, null, 2));
if (outside.length) errors.push(`Network calls outside the test server: ${[...new Set(outside)].join(", ")}`);
await browser.close();
served?.server.close();
if (errors.length) {
  console.error("FAILED:\n- " + errors.join("\n- "));
  process.exit(1);
}
console.log("OK");
