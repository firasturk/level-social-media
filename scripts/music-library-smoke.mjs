/**
 * A browser smoke test of the music library panel (src/video-editor/ui/MusicLibrary.tsx), mounted
 * alone by scripts/harness/music-library.html and served by Vite in dev mode, in headless Chromium,
 * with every /api/studio/music call answered by a mock here (no server, no network, nothing stored).
 * The audio is a short WAV made with ffmpeg into the --out folder (never committed).
 *
 * It checks, at 1280×900:
 *   - the catalog lists with Arabic and English names (the Arabic one right-to-left);
 *   - the mood chip, the tempo band and an Arabic search narrow the list;
 *   - a track plays, its waveform is drawn by the browser once and sent to the cache (PUT /peaks),
 *     and a click on the waveform seeks;
 *   - the licence block shows the licence with its link, the author, the credit with a working
 *     copy button, and "Content ID: registered";
 *   - "Use this track" hands the track with its licence to the parent (onPick);
 *   - the client's tab: the import form refuses a missing confirmation, then uploads with the
 *     licence fields and the new track is listed.
 * Screenshots land in --out (default: ./test-results/music-library).
 *
 * Usage:  node scripts/music-library-smoke.mjs [--out dir]
 */
import { execFileSync, execSync } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

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
const outDir = (() => {
  const i = args.indexOf("--out");
  return i >= 0 ? args[i + 1] : join(process.cwd(), "test-results", "music-library");
})();
await mkdir(outDir, { recursive: true });
const executablePath = process.env.PW_CHROMIUM || "/opt/pw-browsers/chromium";

// Six seconds of pulsing tone: enough for a waveform and a seek.
const WAV_FILE = join(outDir, "tone.wav");
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=330:beep_factor=6:duration=6", "-ac", "1", "-ar", "22050", WAV_FILE]);
const WAV = await readFile(WAV_FILE);

const licence = (id, name, version, url, attribution, attributionRequired) => ({ id, name, version, url, attribution, attributionRequired });
const track = (id, o) => ({
  id,
  kind: id.startsWith("lib:") ? "library" : "catalog",
  url: `/api/studio/music/file?id=${encodeURIComponent(id)}`,
  peaksUrl: `/api/studio/music/peaks?id=${encodeURIComponent(id)}`,
  bpmSource: o.bpm ? "source" : null,
  test: false,
  ...o,
});
const CATALOG = [
  track("cat:upbeat-forever", { title: "Upbeat Forever", artist: "Kevin MacLeod", moods: ["upbeat", "playful"], genre: "Ska", duration: 194.7, bpm: 164, source: { name: "Wikimedia Commons", page: "https://commons.wikimedia.org/wiki/File:Upbeat_Forever_(ISRC_USUAN1500063).mp3", author: "Kevin MacLeod" }, licence: licence("cc-by-3.0", "CC BY 3.0", "3.0", "https://creativecommons.org/licenses/by/3.0/", '"Upbeat Forever" Kevin MacLeod (incompetech.com)\nLicensed under Creative Commons: By Attribution 3.0\nhttps://creativecommons.org/licenses/by/3.0/', true), contentId: { status: "registered", note: "Incompetech says the music is pre-registered with YouTube Content ID.", url: "https://incompetech.com/music/royalty-free/youtube-contentid.html" } }),
  track("cat:desert-city", { title: "Desert City", artist: "Kevin MacLeod", moods: ["arabic", "calm"], genre: "World (Middle Eastern)", duration: 89.4, bpm: 86, source: { name: "Wikimedia Commons", page: "https://commons.wikimedia.org/wiki/File:Desert_City_(ISRC_USUAN1100564).mp3", author: "Kevin MacLeod" }, licence: licence("cc-by-3.0", "CC BY 3.0", "3.0", "https://creativecommons.org/licenses/by/3.0/", '"Desert City" Kevin MacLeod (incompetech.com)\nLicensed under Creative Commons: By Attribution 3.0\nhttps://creativecommons.org/licenses/by/3.0/', true), contentId: { status: "registered", note: "Incompetech says the music is pre-registered with YouTube Content ID.", url: "https://incompetech.com/music/royalty-free/youtube-contentid.html" } }),
  track("cat:goldberg-aria", { title: "Goldberg Variations: Aria", artist: "J. S. Bach (Musopen recording)", moods: ["calm", "corporate"], genre: "Classical piano", duration: 287.1, bpm: null, source: { name: "Wikimedia Commons", page: "https://commons.wikimedia.org/wiki/File:Bach,_Goldberg_Variations,_Aria_(Musopen_version).ogg", author: "Musopen" }, licence: licence("cc0-1.0", "CC0 1.0", "1.0", "https://creativecommons.org/publicdomain/zero/1.0/", "Goldberg Variations: Aria (J. S. Bach), recording by Musopen, CC0 1.0", false), contentId: { status: "unknown", note: "The source says nothing about Content ID." } }),
  track("cat:test-maqsum-100", { title: "إيقاع مقسوم تجريبي — Maqsum test rhythm (Test audio)", artist: "Level studio (generated)", moods: ["arabic", "upbeat"], genre: "Test audio", duration: 12, bpm: 100, test: true, source: { name: "Generated in the studio", page: "", author: "Level studio" }, licence: licence("cc0-1.0", "CC0 1.0", "1.0", "https://creativecommons.org/publicdomain/zero/1.0/", "", false), contentId: { status: "not_registered", note: "Generated by the studio; never registered anywhere." } }),
];
const MOODS = [
  { id: "upbeat", label: "Upbeat" },
  { id: "calm", label: "Calm" },
  { id: "cinematic", label: "Cinematic" },
  { id: "corporate", label: "Corporate" },
  { id: "energy", label: "Sport / energy" },
  { id: "arabic", label: "Arabic-flavoured" },
  { id: "playful", label: "Playful" },
];
const fold = (s) => s.normalize("NFKD").replace(/[̀-ًͯ-ٰٟـ]/g, "").replace(/[إأآٱ]/g, "ا").toLowerCase();
const library = [];
const calls = { peaksPut: [], upload: [], file: 0 };

function list(tracks, q) {
  const p = new URLSearchParams(q);
  let out = tracks;
  if (p.get("mood")) out = out.filter((t) => t.moods.includes(p.get("mood")));
  if (p.get("test") === "0") out = out.filter((t) => !t.test);
  if (p.get("minBpm")) out = out.filter((t) => t.bpm !== null && t.bpm >= Number(p.get("minBpm")));
  if (p.get("maxBpm")) out = out.filter((t) => t.bpm !== null && t.bpm < Number(p.get("maxBpm")));
  if (p.get("q")) out = out.filter((t) => fold(`${t.title} ${t.artist} ${t.genre}`).includes(fold(p.get("q"))));
  return { ok: true, tracks: out, total: tracks.length, moods: MOODS, genres: [...new Set(tracks.map((t) => t.genre))].sort(), access: { admin: true, enabled: true, reason: "" } };
}

async function mockApi(route) {
  const req = route.request();
  const url = new URL(req.url());
  const path = url.pathname.replace("/api/studio/music", "");
  const json = (body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  if (path === "/catalog") return json(list(CATALOG, url.search));
  if (path === "/library") return json(list(library, url.search));
  if (path === "/peaks" && req.method() === "GET") return json({ ok: true, id: url.searchParams.get("id"), peaks: null, cached: false, computed: null });
  if (path === "/peaks" && req.method() === "PUT") {
    const body = JSON.parse(req.postData() || "{}");
    calls.peaksPut.push(body);
    return json({ ok: true, id: body.id, peaks: body.peaks, cached: false });
  }
  if (path === "/file") {
    calls.file++;
    const range = req.headers()["range"];
    const m = range && /bytes=(\d+)-(\d*)/.exec(range);
    if (m) {
      const start = Number(m[1]);
      const end = m[2] ? Math.min(Number(m[2]), WAV.length - 1) : WAV.length - 1;
      return route.fulfill({ status: 206, headers: { "Content-Type": "audio/wav", "Accept-Ranges": "bytes", "Content-Range": `bytes ${start}-${end}/${WAV.length}`, "Content-Length": String(end - start + 1) }, body: WAV.subarray(start, end + 1) });
    }
    return route.fulfill({ status: 200, headers: { "Content-Type": "audio/wav", "Accept-Ranges": "bytes", "Content-Length": String(WAV.length) }, body: WAV });
  }
  if (path === "/library/upload") {
    const body = req.postDataBuffer()?.toString("latin1") ?? "";
    calls.upload.push(body);
    const field = (k) => new RegExp(`name="${k}"\\r\\n\\r\\n([^\\r]*)`).exec(body)?.[1] ?? "";
    const t = track("lib:new-1", { title: Buffer.from(field("title"), "latin1").toString("utf8"), artist: field("artist"), moods: field("moods").split(",").filter(Boolean), genre: field("genre"), duration: 6, bpm: null, source: { name: field("source"), page: field("sourceUrl"), author: field("author") }, licence: licence(field("licence"), field("licenceName"), field("licenceVersion"), field("licenceUrl"), field("attribution"), false), contentId: { status: field("contentId"), note: field("contentIdNote") }, client: "c1", origin: "upload" });
    library.unshift(t);
    return json({ ok: true, track: t });
  }
  return json({ error: `Not mocked: ${req.method()} ${path}` }, 404);
}

const server = await createServer({
  configFile: false,
  root: process.cwd(),
  logLevel: "error",
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": join(process.cwd(), "src"), "@shared": join(process.cwd(), "shared") } },
  server: { port: 0, host: "127.0.0.1", hmr: false },
});
await server.listen();
const base = server.resolvedUrls.local[0].replace(/\/$/, "");

const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
};

const browser = await chromium.launch({ executablePath, args: ["--autoplay-policy=no-user-gesture-required"] });
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, permissions: ["clipboard-read", "clipboard-write"] });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && errors.push(m.text()));
  await page.route("**/api/studio/music/**", mockApi);
  await page.goto(`${base}/scripts/harness/music-library.html`);
  await page.waitForSelector("[data-testid=track]");

  // The catalog, Arabic and English names.
  check((await page.locator("[data-testid=track]").count()) === 4, "the catalog lists 4 tracks");
  const arabic = page.locator(".ml-title", { hasText: "إيقاع" });
  check((await arabic.getAttribute("dir")) === "auto", "an Arabic title is laid out by its own direction (dir=auto)");
  check((await arabic.evaluate((el) => getComputedStyle(el).direction)) === "rtl" || (await arabic.evaluate((el) => getComputedStyle(el).unicodeBidi)) === "plaintext", "the Arabic title renders right-to-left");
  await page.screenshot({ path: join(outDir, "1-catalog.png") });

  // Filters.
  await page.getByRole("button", { name: "Arabic-flavoured", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll("[data-testid=track]").length === 2);
  check(true, "the Arabic-flavoured mood leaves Desert City and the maqsum test loop");
  await page.getByRole("combobox", { name: "Tempo" }).selectOption("slow");
  await page.waitForFunction(() => document.querySelectorAll("[data-testid=track]").length === 1);
  check((await page.locator(".ml-title").first().textContent()) === "Desert City", "the slow tempo band leaves Desert City (86 BPM)");
  await page.getByRole("combobox", { name: "Tempo" }).selectOption("");
  await page.getByRole("button", { name: "All moods", exact: true }).click();
  await page.getByRole("searchbox", { name: "Search tracks" }).fill("ايقاع");
  await page.waitForFunction(() => document.querySelectorAll("[data-testid=track]").length === 1);
  check((await page.locator(".ml-title").first().textContent())?.includes("مقسوم"), "an Arabic search without the hamza finds the Arabic title");
  await page.screenshot({ path: join(outDir, "2-arabic-search.png") });
  await page.getByRole("searchbox", { name: "Search tracks" }).fill("");
  await page.waitForFunction(() => document.querySelectorAll("[data-testid=track]").length === 4);

  // Preview, waveform, seek.
  await page.getByRole("button", { name: "Play Desert City" }).click();
  await page.getByRole("button", { name: "Pause Desert City" }).waitFor({ timeout: 10_000 });
  check(true, "Desert City plays");
  await page.waitForSelector("[data-testid=waveform]", { timeout: 15_000 });
  check(calls.peaksPut.length === 1 && calls.peaksPut[0].id === "cat:desert-city" && calls.peaksPut[0].peaks.length === 400, "the browser drew the waveform once and sent it to the cache (400 peaks)");
  const wave = page.locator("[data-testid=waveform]");
  const box = await wave.boundingBox();
  await page.mouse.click(box.x + box.width * 0.6, box.y + box.height / 2);
  await page.waitForFunction(() => Number(document.querySelector("[data-testid=waveform]")?.getAttribute("aria-valuenow")) >= 55, null, { timeout: 5000 });
  check(true, "a click on the waveform seeks to that point");

  // Licence block.
  const lic = page.locator("[data-testid=licence]");
  check((await lic.getByRole("link", { name: /CC BY 3\.0/ }).getAttribute("href")) === "https://creativecommons.org/licenses/by/3.0/", "the licence links its text (CC BY 3.0)");
  check((await page.locator("[data-testid=content-id]").textContent()) === "Content ID: registered", "Content ID: registered is shown");
  check((await lic.textContent()).includes("Kevin MacLeod"), "the author is shown");
  await lic.getByRole("button", { name: "Copy the credit text" }).click();
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  check(clip.startsWith('"Desert City" Kevin MacLeod (incompetech.com)') && clip.includes("By Attribution 3.0"), "the copy button copies the attribution text");
  await page.screenshot({ path: join(outDir, "3-preview-licence.png") });

  // Pick.
  await page.getByRole("button", { name: "Use this track" }).click();
  const pick = await page.evaluate(() => window.__musicPick);
  check(pick?.track.id === "cat:desert-city" && pick.track.licence.version === "3.0" && pick.track.licence.attributionRequired === true && pick.credit.includes("Desert City") && pick.fileUrl.includes("cat%3Adesert-city"), "onPick hands over the track with its licence, credit and file URL");
  check((await page.getByRole("button", { name: "In use" }).count()) === 1, "the picked track shows as in use");

  // Import into the client's library.
  await page.getByRole("tab", { name: /Habibah/ }).click();
  await page.getByText("No tracks for this client yet.").waitFor();
  await page.getByRole("button", { name: "Import a track" }).click();
  const form = page.getByRole("form", { name: "Import a track" });
  await form.locator("input[type=file]").setInputFiles(WAV_FILE);
  await form.getByLabel("Track name (Arabic or English)").fill("صباح السوق — Souq morning");
  await form.getByLabel("Source: where the track comes from").fill("Commissioned for Habibah, contract 2026-04");
  await form.getByLabel("Author or performer").fill("Oud trio");
  await form.getByLabel("Licence", { exact: true }).selectOption("own");
  await form.getByLabel("Content ID", { exact: true }).selectOption("not_registered");
  await form.getByText("Arabic-flavoured").click();
  await form.getByRole("button", { name: "Import the track" }).click();
  await form.getByRole("alert").waitFor();
  check((await form.getByRole("alert").textContent()).includes("Confirm the rights"), "the import is refused until the rights are confirmed");
  check(calls.upload.length === 0, "nothing was sent without the confirmation");
  await page.screenshot({ path: join(outDir, "4-import-refused.png") });
  await form.getByRole("checkbox", { name: /I confirm we may use this track/ }).check();
  await form.getByRole("button", { name: "Import the track" }).click();
  await page.waitForFunction(() => [...document.querySelectorAll(".ml-title")].some((e) => e.textContent?.includes("Souq morning")), null, { timeout: 10_000 });
  const sent = calls.upload[0] ?? "";
  check(["source", "author", "licence", "licenceName", "contentId", "confirmed", "moods"].every((k) => sent.includes(`name="${k}"`)) && sent.includes("Oud trio") && sent.includes("arabic"), "the upload carries the licence fields");
  check((await page.locator(".ml-title", { hasText: "صباح السوق" }).count()) === 1, "the imported Arabic name is listed");
  await page.screenshot({ path: join(outDir, "5-client-tracks.png") });

  // Phone width: no sideways scroll in the panel.
  await page.setViewportSize({ width: 390, height: 844 });
  check(await page.evaluate(() => document.querySelector(".ml").scrollWidth <= document.querySelector(".ml").clientWidth + 1), "the panel does not scroll sideways");

  check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join(" | ")}` : ""}`);
} finally {
  await browser.close();
  await server.close();
}
console.log(failures.length ? `\n${failures.length} check(s) failed.` : "\nAll checks passed.");
process.exit(failures.length ? 1 : 0);
