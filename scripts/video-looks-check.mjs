/**
 * Phase 3 of the video editor checked on real rendered files (docs/video-editor.md → Phase 3):
 * the editor's engine (scripts/video-looks-check/harness.ts, bundled with Vite) runs in headless
 * Chromium on fixtures made here with ffmpeg and renders:
 *   1. a template ("Product launch") applied to three sample clips, with Warm Film at 60 % on one
 *      clip, Bold Sport on another, a third clip's colour matched to a warm reference picture, and
 *      a catalog music track (the catalog's generated test loop, served the way the music library
 *      serves a track; no network);
 *   2. the colour match on its own (the same clip before and after) against the reference;
 *   3. a LUT kept with the draft (serialised, saved as JSON, read back, rendered with no file);
 *   4. skin protection on and off under a harsh grade;
 * then inspects the files with ffprobe and ffmpeg: the preview's frame against the render's at the
 * same times (mean colour), the render's pixels against the CPU twin of the shader
 * (shared/video-looks.ts gradePixel), the match's Lab distance to the reference before and after,
 * the skin patch's hue. It also draws the preset thumbnails from one frame into a contact sheet.
 *
 * Open-source Chromium has no H.264 or AAC, so the renders use the engine's test codecs (VP9 + Opus
 * in MP4); everything else is the studio's path.
 *
 * Usage:  node scripts/video-looks-check.mjs [--out <dir>]   (needs ffmpeg/ffprobe on PATH)
 */
import { createServer } from "node:http";
import { execFileSync, execSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const outDir = args.includes("--out") ? args[args.indexOf("--out") + 1] : join(root, "smoke", "video-looks");
mkdirSync(outDir, { recursive: true });
const work = mkdtempSync(join(tmpdir(), "video-looks-check-"));
const fx = join(work, "fx");
mkdirSync(fx);

async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch {
    const g = execSync("npm root -g", { encoding: "utf8" }).trim();
    return import(pathToFileURL(join(g, "playwright", "index.mjs")).href);
  }
}

const ff = (...a) => execFileSync("ffmpeg", ["-v", "error", "-y", ...a], { stdio: ["ignore", "ignore", "inherit"] });
const VP9_709 = ["-c:v", "libvpx-vp9", "-b:v", "1500k", "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-color_range", "tv"];

/* ───────────── 1. Fixtures: flat colour bands with a little grain, so pixels can be predicted ───────────── */
function bands(file, w, h, colours, seconds, freq) {
  const bh = Math.round(h / colours.length);
  const inputs = colours.flatMap((c) => ["-f", "lavfi", "-i", `color=c=${c}:s=${w}x${bh}:r=30:d=${seconds}`]);
  const n = colours.length;
  const chain = `${colours.map((_, i) => `[${i}]`).join("")}vstack=${n},noise=alls=5:allf=t,scale=out_color_matrix=bt709:out_range=tv,format=yuv420p[v]`;
  ff(...inputs, "-f", "lavfi", "-i", `sine=f=${freq}:d=${seconds}`, "-filter_complex", chain, "-map", "[v]", "-map", `${n}:a`, ...VP9_709, "-c:a", "libopus", "-b:a", "64k", join(fx, file));
}
// A product scene (sky, leaves, a white box, wood, a dark floor), 640×360.
bands("scene.mp4", 640, 360, ["0x6f8fae", "0x3c8c46", "0xf0f0f0", "0xb08a64", "0x2a2a2a"], 4, 440);
// A portrait (9:16): slate background, skin, a red product, white.
bands("portrait.mp4", 360, 640, ["0x5a6e8c", "0xe1af91", "0xc81e28", "0xf0f0f0"], 4, 550);
// A cool, blue-cast scene to match to the warm reference.
bands("cool.mp4", 640, 360, ["0x40607f", "0x7090b0", "0x2a3a50", "0xa0b8d0", "0x506070"], 4, 660);
// The warm reference picture (a sunset palette).
ff("-f", "lavfi", "-i", "color=c=0xd08850:s=400x100:d=1", "-f", "lavfi", "-i", "color=c=0xf0c890:s=400x100:d=1", "-f", "lavfi", "-i", "color=c=0x804020:s=400x100:d=1", "-f", "lavfi", "-i", "color=c=0xe0a070:s=400x100:d=1",
  "-filter_complex", "[0][1][2][3]vstack=4,noise=alls=6:allf=t,format=rgb24[v]", "-map", "[v]", "-frames:v", "1", join(fx, "ref-warm.png"));

/* ───────────── 2. The harness, and the catalog's test track (synthesised by the shared code) ───────────── */
const harnessOut = join(work, "harness");
const alias = { "@": join(root, "src"), "@shared": join(root, "shared") };
await build({ configFile: false, logLevel: "warn", root: join(root, "scripts", "video-looks-check"), resolve: { alias }, build: { outDir: harnessOut, emptyOutDir: true, minify: false } });
const entry = join(work, "music-entry.ts");
writeFileSync(entry, `export { synthTestWav } from ${JSON.stringify(join(root, "shared", "music-test-audio.ts"))};\nexport { catalogEntry } from ${JSON.stringify(join(root, "shared", "music-catalog.ts"))};\n`);
await build({ configFile: false, logLevel: "warn", resolve: { alias }, build: { ssr: entry, outDir: join(work, "node"), emptyOutDir: true, minify: false, rollupOptions: { output: { format: "es", entryFileNames: "music.mjs" } } } });
const { synthTestWav, catalogEntry } = await import(pathToFileURL(join(work, "node", "music.mjs")).href);
const TRACK = "test-beat-120";
const WAV = Buffer.from(synthTestWav(catalogEntry(TRACK).synth));

const MIME = { ".html": "text/html", ".js": "text/javascript", ".mp4": "video/mp4", ".png": "image/png", ".wav": "audio/wav" };
const server = createServer((req, res) => {
  const u = new URL(req.url ?? "/", "http://x");
  const path = decodeURIComponent(u.pathname);
  if (path === "/api/studio/music/file") {
    // The music library's Range route, as the editor reads a catalog track on reopen.
    if (u.searchParams.get("id") !== `cat:${TRACK}`) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { "content-type": "audio/wav", "accept-ranges": "bytes", "content-length": WAV.length });
    return res.end(WAV);
  }
  const file = path.startsWith("/fx/") ? join(fx, path.slice(4)) : join(harnessOut, path === "/" ? "index.html" : path);
  try {
    const data = readFileSync(file);
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}`;

/* ───────────── 3. The browser ───────────── */
const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || "/opt/pw-browsers/chromium", headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
const page = await browser.newPage({ viewport: { width: 800, height: 900 } });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));
await page.goto(url);
await page.waitForFunction(() => document.title === "ready", null, { timeout: 30000 });
const H = (fn, ...a) => page.evaluate(([f, x]) => window.harness[f](...x), [fn, a]);

const report = { generated: new Date().toISOString(), codecs: "VP9 + Opus in MP4 (the Playwright Chromium has no H.264/AAC)", fixtures: {}, renders: {}, checks: [] };
const fails = [];
const check = (what, expected, observed, ok) => {
  report.checks.push({ what, expected, observed, ok });
  if (!ok) fails.push(`${what}: expected ${expected}, observed ${observed}`);
};
for (const n of ["scene.mp4", "portrait.mp4", "cool.mp4"]) report.fixtures[n] = await H("addSource", n, `/fx/${n}`);
const music = await H("loadCatalogMusic", TRACK);
report.music = { trackId: music.source.trackId, name: music.source.name, licence: music.source.rights.licence, credit: music.source.rights.credit, contentId: music.source.rights.contentId.status, test: !!music.source.rights.test, status: music.status, duration: music.duration };
check("Catalog track read through the music library's file route", "200, decoded", `${music.status}, ${music.duration.toFixed(1)} s`, music.status === 200 && music.duration > 5);

/* ───────────── 4. The main project: a template, two presets, a match, the catalog track ───────────── */
let main = await H("template", "product-launch", ["scene.mp4", "portrait.mp4", "cool.mp4"], { output: { width: 1080, height: 1920, fps: 30, bitrate: 4_000_000 } });
const fit = await H("fitMatch", "cool.mp4", { in: main.clips[2].in, out: main.clips[2].out }, "/fx/ref-warm.png", "ref-warm.png");
main.clips[0] = { ...main.clips[0], look: { id: "warm-film", amount: 0.6 } };
main.clips[1] = { ...main.clips[1], look: { id: "bold-sport", amount: 1 } };
main.clips[2] = { ...main.clips[2], look: { id: "none", amount: 1 }, match: fit.match };
main.music = { source: music.source, offset: 0, volume: 0.9, fadeIn: 0.5, fadeOut: 1, duration: music.duration };
const valid = await H("validate", main);
check("Template project (Product launch + presets + match + catalog track) passes validateProject", "ok", valid.ok ? "ok" : valid.reason, valid.ok);
main = valid.project;
report.mainProject = { template: main.template, clips: main.clips.map((c) => ({ source: c.source.name, in: c.in, out: c.out, look: c.look ?? null, match: c.match ? { scale: c.match.scale, offset: c.match.offset, frames: c.match.frames } : null })), look: main.look, lookAmount: main.lookAmount, overlays: main.overlays.map((o) => (o.kind === "text" ? o.text : o.name)), music: main.music.source };
check("Template filled: shots, texts in Arabic and English", "5 clips, 6 text layers incl. Arabic", `${main.clips.length} clips, ${main.overlays.length} layers${main.overlays.some((o) => /[؀-ۿ]/.test(o.text ?? "")) ? " incl. Arabic" : ""}`, main.clips.length === 5 && main.overlays.length === 6 && main.overlays.some((o) => /[؀-ۿ]/.test(o.text ?? "")));
check("Match fitted once from several frames of the clip", "5 frames", `${fit.match.frames} frames, scale ${fit.match.scale.join("/")}, offset ${fit.match.offset.join("/")}`, fit.match.frames === 5);

const placed = await H("placed", main);
// A time well inside each clip (past any crossfade, before the next).
const times = placed.map((p) => Math.round((p.start + p.overlap + (p.end - p.start - p.overlap) * 0.55) * 30) / 30);
const r1 = await H("render", main);
const mainFile = join(work, "main.mp4");
writeFileSync(mainFile, Buffer.from(r1.mp4, "base64"));
report.renders.main = { ms: r1.ms, engine: { width: r1.width, height: r1.height, duration: r1.duration, frames: r1.frames } };

const probe = (file) => JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", file], { encoding: "utf8" }));
/** One decoded frame at t as RGB at w×h, read with the BT.709 limited-range matrix the file is tagged with. */
function frameAt(file, t, w, h) {
  const raw = execFileSync("ffmpeg", ["-v", "error", "-ss", String(t), "-i", file, "-frames:v", "1", "-vf", `scale=${w}:${h}:in_color_matrix=bt709:in_range=tv:flags=area`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { maxBuffer: 64 * 1024 * 1024 });
  const at = (x, y) => {
    const px = Math.min(w - 3, Math.max(2, Math.floor(x * w)));
    const py = Math.min(h - 3, Math.max(2, Math.floor(y * h)));
    const s = [0, 0, 0];
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) for (let c = 0; c < 3; c++) s[c] += raw[((py + dy) * w + px + dx) * 3 + c];
    return s.map((v) => Math.round(v / 25));
  };
  const mean = [0, 0, 0];
  for (let i = 0; i < raw.length; i += 3) for (let c = 0; c < 3; c++) mean[c] += raw[i + c];
  return { raw, at, mean: mean.map((v) => v / (raw.length / 3)), w, h };
}
const savePng = (file, t, name) => ff("-ss", String(t), "-i", file, "-frames:v", "1", "-vf", "scale=in_color_matrix=bt709:in_range=tv", join(outDir, name));
const dataUrlTo = (d, name) => writeFileSync(join(outDir, name), Buffer.from(d.split(",")[1], "base64"));

const p1 = probe(mainFile);
const v1 = p1.streams.find((s) => s.codec_type === "video");
const a1 = p1.streams.find((s) => s.codec_type === "audio");
const total = placed.at(-1).end;
check("Main render: encoded size (ffprobe)", "1080×1920", `${v1.width}×${v1.height}`, v1.width === 1080 && v1.height === 1920);
check("Main render: length", `${total.toFixed(2)} s (the template's shots)`, `${Number(p1.format.duration).toFixed(2)} s`, Math.abs(Number(p1.format.duration) - total) < 0.1);
check("Main render: audio track (the catalog track)", "present", a1 ? `${a1.codec_name} ${a1.sample_rate} Hz` : "none", !!a1);
const vd = execSync(`ffmpeg -hide_banner -i "${mainFile}" -af volumedetect -f null - 2>&1 | grep mean_volume || true`, { encoding: "utf8" });
const meanDb = Number((/mean_volume: (-?[\d.]+) dB/.exec(vd) ?? [])[1]);
check("Main render: sound level", "mean above -40 dB", `${meanDb} dB`, meanDb > -40);
report.renders.main.ffprobe = { codec: v1.codec_name, width: v1.width, height: v1.height, nb_frames: v1.nb_frames, color: `${v1.color_space}/${v1.color_primaries}/${v1.color_transfer}/${v1.color_range}`, audio: a1 ? a1.codec_name : null, duration: Number(p1.format.duration) };

// Points to predict per clip (fractions of the frame), away from the template's words.
const POINTS = {
  0: [[0.2, 0.4], [0.2, 0.5], [0.8, 0.62]],
  1: [[0.15, 0.12], [0.15, 0.38], [0.15, 0.6], [0.85, 0.9]],
  2: [[0.15, 0.4], [0.15, 0.55], [0.85, 0.65]],
  3: [[0.2, 0.4], [0.8, 0.6]],
  4: [[0.15, 0.38], [0.15, 0.6]],
};
const LABEL = { 0: "Warm Film 60 % (scene)", 1: "Bold Sport 100 % (portrait: slate, skin, red product, white)", 2: "matched to the warm reference (cool scene)", 3: "the template's Cool Editorial 70 % (scene)", 4: "the template's Cool Editorial 70 % (portrait)" };
const maxDiff = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));
report.samples = [];
for (const [i, t] of times.entries()) {
  const pts = POINTS[i];
  const after = await H("preview", main, t, pts, { png: true });
  const before = await H("preview", main, t, pts, { bypass: true });
  const fr = frameAt(mainFile, t, after.size[0], after.size[1]);
  dataUrlTo(after.png, `main-preview-${t.toFixed(2)}s.png`);
  savePng(mainFile, t, `main-render-${t.toFixed(2)}s.png`);
  const meanDiff = maxDiff(after.mean, fr.mean);
  check(`Preview vs render, whole-frame mean at ${t.toFixed(2)} s (${LABEL[i]})`, "within 4/255 per channel", `${after.mean.map((v) => v.toFixed(1)).join(",")} vs ${fr.mean.map((v) => v.toFixed(1)).join(",")} (Δ ${meanDiff.toFixed(2)})`, meanDiff <= 4);
  const sample = { t, clip: i, look: LABEL[i], points: [] };
  for (const [k, [x, y]] of pts.entries()) {
    const raw = before.pixels[k];
    const want = await H("expected", main, i, raw);
    const got = fr.at(x, y);
    const pv = after.pixels[k];
    sample.points.push({ x, y, raw, expected: want, render: got, preview: pv });
    // The preview is the same shader as the render: it must equal the CPU twin closely. The render adds its
    // own decode (WebCodecs) and the encoder's quantisation (VP9 at 4 Mbit/s on grain), so a wider margin.
    check(`Preview pixel at ${t.toFixed(2)} s (${x}, ${y}) = the shader's CPU twin on the raw colour [${LABEL[i]}]`, `${want.join(",")} (raw ${raw.join(",")}) ±4`, pv.join(","), maxDiff(want, pv) <= 4);
    check(`Render pixel at ${t.toFixed(2)} s (${x}, ${y}) = the CPU twin [${LABEL[i]}]`, `${want.join(",")} ±12`, got.join(","), maxDiff(want, got) <= 12);
  }
  report.samples.push(sample);
}
// What the looks did, in words: Warm Film warmed, the match moved toward the warm reference.
{
  const s0 = report.samples[0].points[0];
  check("Warm Film 60 % warms the scene (red minus blue grows)", "R−B after > R−B raw", `${s0.render[0] - s0.render[2]} vs ${s0.raw[0] - s0.raw[2]}`, s0.render[0] - s0.render[2] > s0.raw[0] - s0.raw[2]);
  const s2 = report.samples[2].points[0];
  check("The match turns the cool scene warm (red minus blue goes from negative to positive)", "R−B raw < 0 < R−B after", `${s2.raw[0] - s2.raw[2]} → ${s2.render[0] - s2.render[2]}`, s2.raw[0] - s2.raw[2] < 0 && s2.render[0] - s2.render[2] > 0);
}

/* ───────────── 5. The match alone: before and after against the reference ───────────── */
{
  const clipA = { id: "ma", source: { kind: "upload", name: "cool.mp4", size: 0 }, duration: 4, in: 1, out: 2.5, speed: 1, transition: "cut", transitionDuration: 0.5 };
  const m = await H("fitMatch", "cool.mp4", { in: 1, out: 2.5 }, "/fx/ref-warm.png", "ref-warm.png");
  const proj = { ...main, template: null, overlays: [], music: null, look: "none", lookAmount: 1, colour: { ...main.colour }, output: { width: 540, height: 960, fps: 30, bitrate: 2_000_000 }, framing: { fit: "fill", zoom: 1, x: 0, y: 0 }, clips: [clipA, { ...clipA, id: "mb", match: m.match }] };
  const r = await H("render", proj);
  const f = join(work, "match.mp4");
  writeFileSync(f, Buffer.from(r.mp4, "base64"));
  const rgbB64 = (t) => frameAt(f, t, 540, 960).raw.toString("base64");
  const before = await H("labOfRgb", rgbB64(0.75), m.refStats);
  const after = await H("labOfRgb", rgbB64(2.25), m.refStats);
  savePng(f, 0.75, "match-before.png");
  savePng(f, 2.25, "match-after.png");
  report.match = { fitted: { scale: m.match.scale, offset: m.match.offset, frames: m.match.frames }, reference: { mean: m.refStats.mean, std: m.refStats.std }, clipBefore: { mean: m.clipStats.mean, std: m.clipStats.std }, renderBefore: before, renderAfter: after };
  check("Colour match: Lab distance of the rendered frame to the reference (mean and spread)", "after < half of before", `${before.distance.toFixed(1)} → ${after.distance.toFixed(1)}`, after.distance < before.distance * 0.5);
  check("Colour match: the rendered frame's a* and b* move toward the reference's", `a* ${m.refStats.mean[1].toFixed(1)}, b* ${m.refStats.mean[2].toFixed(1)}`, `a* ${before.mean[1].toFixed(1)} → ${after.mean[1].toFixed(1)}, b* ${before.mean[2].toFixed(1)} → ${after.mean[2].toFixed(1)}`, Math.abs(after.mean[2] - m.refStats.mean[2]) < Math.abs(before.mean[2] - m.refStats.mean[2]) && Math.abs(after.mean[1] - m.refStats.mean[1]) < Math.abs(before.mean[1] - m.refStats.mean[1]) + 1);
}

/* ───────────── 6. A LUT kept with the draft, rendered after a save and reopen ───────────── */
{
  const clip = { id: "l1", source: { kind: "upload", name: "portrait.mp4", size: 0 }, duration: 4, in: 0.5, out: 1.5, speed: 1, transition: "cut", transitionDuration: 0.5 };
  const base = { ...main, template: null, overlays: [], music: null, look: "none", lookAmount: 1, colour: { ...main.colour }, output: { width: 540, height: 960, fps: 30, bitrate: 2_000_000 }, framing: { fit: "fill", zoom: 1, x: 0, y: 0 }, clips: [clip] };
  const big = await H("withStoredLut", base, 40, 1);
  check("A 40³ table is stored at 33³ (the size bound)", "size 33, 33³×3 bytes as base64", `size ${big.project.lut.size}, ${big.chars} characters`, big.project.lut.size === 33 && big.chars === Math.ceil((33 ** 3 * 3) / 3) * 4);
  const stored = await H("withStoredLut", base, 17, 0.8);
  const r = await H("render", stored.project);
  const f = join(work, "lut.mp4");
  writeFileSync(f, Buffer.from(r.mp4, "base64"));
  const pts = [[0.5, 0.12], [0.5, 0.38], [0.5, 0.62], [0.5, 0.88]];
  const raw = await H("preview", { ...stored.project, lut: null }, 0.5, pts, { bypass: true });
  const fr = frameAt(f, 0.5, 540, 960);
  report.lut = { chars17: stored.chars, points: [] };
  for (const [k, [x, y]] of pts.entries()) {
    const want = await H("expected", stored.project, 0, raw.pixels[k]);
    const got = fr.at(x, y);
    report.lut.points.push({ x, y, raw: raw.pixels[k], expected: want, render: got });
    check(`LUT from the saved draft (no file loaded) at (${x}, ${y})`, `${want.join(",")} (raw ${raw.pixels[k].join(",")}) ±8`, got.join(","), maxDiff(want, got) <= 8);
  }
  savePng(f, 0.5, "lut-render.png");
}

/* ───────────── 7. Skin protection on and off under a harsh grade ───────────── */
{
  const hue = ([r, g, b]) => {
    const mx = Math.max(r, g, b);
    const mn = Math.min(r, g, b);
    const d = mx - mn;
    if (!d) return 0;
    let h = mx === r ? 60 * (((g - b) / d) % 6) : mx === g ? 60 * ((b - r) / d + 2) : 60 * ((r - g) / d + 4);
    return h < 0 ? h + 360 : h;
  };
  const hd = (a, b) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));
  const clip = { id: "s1", source: { kind: "upload", name: "portrait.mp4", size: 0 }, duration: 4, in: 0.5, out: 1.5, speed: 1, transition: "cut", transitionDuration: 0.5 };
  const harsh = { ...main.colour, temperature: -0.8, tint: -0.4, saturation: 0.4 };
  const base = { ...main, template: null, overlays: [], music: null, look: "bold-sport", lookAmount: 1, colour: harsh, lut: null, output: { width: 540, height: 960, fps: 30, bitrate: 2_000_000 }, framing: { fit: "fill", zoom: 1, x: 0, y: 0 }, clips: [clip] };
  const pts = [[0.5, 0.38], [0.5, 0.62], [0.5, 0.12]];
  const raw = await H("preview", base, 0.5, pts, { bypass: true });
  const out = {};
  for (const on of [false, true]) {
    const r = await H("render", { ...base, protectSkin: on });
    const f = join(work, `skin-${on}.mp4`);
    writeFileSync(f, Buffer.from(r.mp4, "base64"));
    savePng(f, 0.5, `skin-protect-${on ? "on" : "off"}.png`);
    const fr = frameAt(f, 0.5, 540, 960);
    out[on] = pts.map(([x, y]) => fr.at(x, y));
  }
  const skinRaw = raw.pixels[0];
  const offShift = hd(hue(out.false[0]), hue(skinRaw));
  const onShift = hd(hue(out.true[0]), hue(skinRaw));
  const wantOff = await H("expected", { ...base, protectSkin: false }, 0, skinRaw);
  const wantOn = await H("expected", { ...base, protectSkin: true }, 0, skinRaw);
  report.skin = { raw: raw.pixels, off: out.false, on: out.true, expectedOff: wantOff, expectedOn: wantOn, hueRaw: hue(skinRaw), hueOff: hue(out.false[0]), hueOn: hue(out.true[0]), hueExpectedOff: hue(wantOff), hueExpectedOn: hue(wantOn) };
  check("Skin protection: the skin patch's hue under a harsh cool grade", "on: shift under half of off", `raw ${hue(skinRaw).toFixed(1)}°, off ${hue(out.false[0]).toFixed(1)}° (shift ${offShift.toFixed(1)}°), on ${hue(out.true[0]).toFixed(1)}° (shift ${onShift.toFixed(1)}°)`, offShift > 3 && onShift < offShift / 2);
  check("Skin protection: the rendered skin patch = the CPU twin, off and on", `off ${wantOff.join(",")}, on ${wantOn.join(",")} (±12)`, `off ${out.false[0].join(",")}, on ${out.true[0].join(",")}`, maxDiff(wantOff, out.false[0]) <= 12 && maxDiff(wantOn, out.true[0]) <= 12);
  check("Skin protection leaves the red product and the slate background graded", "same with and without (±4)", `red ${out.false[1].join(",")} / ${out.true[1].join(",")}, slate ${out.false[2].join(",")} / ${out.true[2].join(",")}`, maxDiff(out.false[1], out.true[1]) <= 4 && maxDiff(out.false[2], out.true[2]) <= 4);
}

/* ───────────── 8. Thumbnails from one frame, the split view ───────────── */
{
  const sheet = await H("contactSheet", main, 1, 1.0);
  dataUrlTo(sheet.png, "preset-thumbnails.png");
  report.thumbnails = { ids: sheet.ids, means: sheet.means, size: sheet.thumb };
  const [none, , warm, cool, matte, bold] = sheet.means;
  const rb = (m) => m[0] - m[2];
  check("Thumbnails: Warm Film warmer than None, Cool Editorial cooler", "R−B: warm > none > cool", `${rb(warm)} > ${rb(none)} > ${rb(cool)}`, rb(warm) > rb(none) && rb(none) > rb(cool));
  check("Thumbnails: the six differ (each preset changes the frame)", "6 distinct means", sheet.means.map((m) => m.join(",")).join(" | "), new Set(sheet.means.map((m) => m.join(","))).size === 6);
  void matte;
  void bold;
  const split = await H("preview", main, times[1], [[0.25, 0.38], [0.75, 0.38]], { split: 0.5, png: true });
  dataUrlTo(split.png, "split-view-preview.png");
  const plain = await H("preview", main, times[1], [[0.25, 0.38], [0.75, 0.38]], { bypass: true });
  const graded = await H("preview", main, times[1], [[0.25, 0.38], [0.75, 0.38]]);
  check("Split view: the left half is the footage before colour, the right half after", "left ≈ before, right ≈ after (±6)", `left ${split.pixels[0].join(",")} vs before ${plain.pixels[0].join(",")}; right ${split.pixels[1].join(",")} vs after ${graded.pixels[1].join(",")}`, maxDiff(split.pixels[0], plain.pixels[0]) <= 6 && maxDiff(split.pixels[1], graded.pixels[1]) <= 6);
}

await browser.close();
server.close();
if (pageErrors.length) fails.push(...pageErrors.map((e) => `page error: ${e}`));

writeFileSync(join(outDir, "render-main-vp9.mp4"), readFileSync(mainFile));
ff("-i", mainFile, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "24", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", join(outDir, "render-main-h264-transcode.mp4"));
report.ok = fails.length === 0;
report.failures = fails;
writeFileSync(join(outDir, "report.json"), JSON.stringify(report, null, 2));
rmSync(work, { recursive: true, force: true });
console.log(report.checks.map((c) => `${c.ok ? "ok  " : "FAIL"} ${c.what}: expected ${c.expected}, observed ${c.observed}`).join("\n"));
if (fails.length) {
  console.error("FAILED:\n- " + fails.join("\n- "));
  process.exit(1);
}
console.log(`OK · report in ${join(outDir, "report.json")}`);
