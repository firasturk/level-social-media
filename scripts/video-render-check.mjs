/**
 * The video editor's render, checked on real output files (not JSON): the editor's engine
 * (scripts/video-render-check/harness.ts, bundled with Vite) runs in headless Chromium on fixtures
 * made here with ffmpeg, renders, and the files that come back are inspected with mp4box and
 * ffprobe/ffmpeg: encoded width and height per frame (9:16, 4:5, 1:1, 16:9), length, the audio
 * track, the crop (Fill centred, Fill panned, Fit with the background), the orientation of a
 * rotated phone-style clip, trim and order, the text (English and Arabic) and the logo at the
 * right times, the colour tags and the colours themselves, and the preview's pixels against the
 * export's at the same times.
 *
 * Open-source Chromium has no H.264 or AAC, so the render here uses the engine's test codecs
 * (VP9 + Opus in MP4, `TEST_CODECS`): everything but the encoder's codec is the studio's path.
 *
 * Usage:  node scripts/video-render-check.mjs [--out <dir>]   (needs ffmpeg/ffprobe on PATH)
 * Prints a JSON report and "OK", or the failures; with --out the 9:16 render, its still and an
 * H.264 transcode (for viewing only) are written there.
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
const outDir = args.includes("--out") ? args[args.indexOf("--out") + 1] : null;
const work = mkdtempSync(join(tmpdir(), "video-render-check-"));
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
const VP9_709 = ["-c:v", "libvpx-vp9", "-b:v", "800k", "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-color_range", "tv"];

/* ───────────── 1. Fixtures ───────────── */
// Three vertical bands, red | green | blue, 640×360 landscape, BT.709 (converted and tagged), a 440 Hz tone.
ff("-f", "lavfi", "-i", "color=c=red:s=214x360:r=30:d=3", "-f", "lavfi", "-i", "color=c=0x00ff00:s=212x360:r=30:d=3", "-f", "lavfi", "-i", "color=c=blue:s=214x360:r=30:d=3", "-f", "lavfi", "-i", "sine=f=440:d=3",
  "-filter_complex", "[0][1][2]hstack=3,scale=out_color_matrix=bt709:out_range=tv,format=yuv420p[v]", "-map", "[v]", "-map", "3:a", ...VP9_709, "-c:a", "libopus", "-b:a", "64k", join(fx, "bands.mp4"));
// One colour per second (red, green, blue), 640×360, no colour tags at all (the editor assumes BT.601 below 720 lines, as players do).
ff("-f", "lavfi", "-i", "color=c=red:s=640x360:r=30:d=1", "-f", "lavfi", "-i", "color=c=0x00ff00:s=640x360:r=30:d=1", "-f", "lavfi", "-i", "color=c=blue:s=640x360:r=30:d=1", "-f", "lavfi", "-i", "sine=f=550:d=3",
  "-filter_complex", "[0][1][2]concat=n=3:v=1:a=0,format=yuv420p[v]", "-map", "[v]", "-map", "3:a", "-c:v", "libvpx-vp9", "-b:v", "800k", "-c:a", "libopus", "-b:a", "64k", join(fx, "steps.mp4"));
// A phone held upright: portrait content (yellow top, magenta bottom) stored as landscape pixels with a 90° display matrix.
ff("-f", "lavfi", "-i", "color=c=yellow:s=360x320:r=30:d=2", "-f", "lavfi", "-i", "color=c=magenta:s=360x320:r=30:d=2", "-f", "lavfi", "-i", "sine=f=660:d=2",
  "-filter_complex", "[0][1]vstack,transpose=2,format=yuv420p[v]", "-map", "[v]", "-map", "2:a", "-c:v", "libvpx-vp9", "-b:v", "600k", "-c:a", "libopus", "-b:a", "64k", join(fx, "coded.mp4"));
ff("-display_rotation:v:0", "-90", "-i", join(fx, "coded.mp4"), "-c", "copy", join(fx, "rotated.mp4"));
ff("-f", "lavfi", "-i", "color=c=cyan:s=200x100:d=1", "-frames:v", "1", join(fx, "logo.png"));
ff("-f", "lavfi", "-i", "sine=f=220:d=6", "-ac", "2", "-ar", "48000", join(fx, "music.wav"));

/* ───────────── 2. The harness, built ───────────── */
const harnessOut = join(work, "harness");
await build({
  configFile: false,
  logLevel: "warn",
  root: join(root, "scripts", "video-render-check"),
  resolve: { alias: { "@": join(root, "src"), "@shared": join(root, "shared") } },
  build: { outDir: harnessOut, emptyOutDir: true, minify: false },
});

const MIME = { ".html": "text/html", ".js": "text/javascript", ".mp4": "video/mp4", ".png": "image/png", ".wav": "audio/wav" };
const server = createServer((req, res) => {
  const path = decodeURIComponent((req.url ?? "/").split("?")[0]);
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

/* ───────────── 3. The projects ───────────── */
const logo = `data:image/png;base64,${readFileSync(join(fx, "logo.png")).toString("base64")}`;
const FRAMING = { fit: "fill", zoom: 1, x: 0, y: 0 };
const project = (name, output, clips, extra = {}) => ({
  v: 1, rev: 1, createdAt: 1, updatedAt: 1, name, clips, look: "none",
  colour: { exposure: 0, contrast: 0, saturation: 0, temperature: 0, tint: 0, highlights: 0, shadows: 0 },
  lut: null, music: null, output: { ...output, fps: 30, bitrate: 4_000_000 }, snapToBeats: false,
  framing: FRAMING, background: "#808080", overlays: [], ...extra,
});
const clip = (id, name, duration, inPt, outPt, more = {}) => ({ id, source: { kind: "upload", name, size: 0 }, duration, in: inPt, out: outPt, speed: 1, transition: "cut", transitionDuration: 0.5, ...more });

/* ───────────── 4. Render in the browser ───────────── */
const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || "/opt/pw-browsers/chromium", headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
const page = await browser.newPage({ viewport: { width: 800, height: 900 } });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));
await page.goto(url);
await page.waitForFunction(() => document.title === "ready", null, { timeout: 30000 });
const fails = [];
const report = { fixtures: {}, renders: {} };

const sizes = {};
for (const name of ["bands.mp4", "steps.mp4", "rotated.mp4"]) {
  const s = await page.evaluate(async ([n, u]) => window.harness.addSource(n, u), [name, `/fx/${name}`]);
  sizes[name] = s;
}
report.fixtures = sizes;
if (sizes["rotated.mp4"].width !== 360 || sizes["rotated.mp4"].height !== 640) fails.push(`The rotated clip should show 360×640 in a <video>, got ${sizes["rotated.mp4"].width}×${sizes["rotated.mp4"].height}.`);
await page.evaluate(async (u) => window.harness.setMusic(u), "/fx/music.wav");

const main = project("Main 9:16", { width: 1080, height: 1920 }, [
  clip("c1", "steps.mp4", 3, 1, 2), // trimmed to the green second
  clip("c2", "rotated.mp4", 2, 0, 1), // the phone clip
  clip("c3", "bands.mp4", 3, 0, 1, { framing: { fit: "fit", zoom: 1, x: 0, y: 0 } }), // Fit: the whole picture over the background
  clip("c4", "bands.mp4", 3, 1, 2, { framing: { fit: "fill", zoom: 1, x: -1, y: 0 } }), // Fill panned to the left edge
], {
  overlays: [
    { id: "t1", kind: "text", text: "MOVE YOUR WAY", start: 0, end: 1, x: 0.5, y: 0.12, size: 0.05, color: "#ffffff", font: "sans", weight: 800, align: "center", box: "#000000", width: 0.86 },
    { id: "t2", kind: "text", text: "تحرّك بطريقتك", start: 1, end: 2, x: 0.5, y: 0.12, size: 0.05, color: "#ffffff", font: "sans", weight: 800, align: "center", box: "#000000", width: 0.86 },
    { id: "l1", kind: "logo", src: logo, name: "Logo", start: 0, end: 4, x: 0.85, y: 0.93, width: 0.2, opacity: 1 },
  ],
  music: { source: { kind: "upload", name: "music.wav", size: 0 }, offset: 0, volume: 0.9, fadeIn: 0, fadeOut: 0.5 },
});

const renders = [
  ["9:16", main],
  ["4:5", project("4:5", { width: 1080, height: 1350 }, [clip("r1", "bands.mp4", 3, 0, 0.5)])],
  ["1:1", project("1:1", { width: 1080, height: 1080 }, [clip("r1", "bands.mp4", 3, 0, 0.5)])],
  ["16:9", project("16:9", { width: 1920, height: 1080 }, [clip("r1", "bands.mp4", 3, 0, 0.5)])],
];
const files = {};
for (const [id, p] of renders) {
  const r = await page.evaluate(async (proj) => window.harness.render(proj), p);
  const file = join(work, `render-${id.replace(":", "x")}.mp4`);
  writeFileSync(file, Buffer.from(r.mp4, "base64"));
  if (r.still) writeFileSync(file.replace(/\.mp4$/, ".still.jpg"), Buffer.from(r.still, "base64"));
  files[id] = file;
  report.renders[id] = { ms: r.ms, bytes: Buffer.from(r.mp4, "base64").length, engine: { width: r.width, height: r.height, duration: r.duration, frames: r.frames, codec: r.videoCodec, colour: r.colour }, sources: r.sources };
}

/* ───────────── 5. The preview, at the same times ───────────── */
const SAMPLE = {
  0.5: [[0.5, 0.5, "green"], [0.1, 0.5, "green"], [0.85, 0.93, "cyan"]],
  1.5: [[0.5, 0.3, "yellow"], [0.5, 0.75, "magenta"], [0.85, 0.93, "cyan"]],
  2.5: [[0.5, 0.3, "grey"], [0.1, 0.5, "red"], [0.5, 0.5, "green"], [0.9, 0.5, "blue"], [0.85, 0.93, "cyan"]],
  3.5: [[0.5, 0.5, "red"], [0.9, 0.5, "red"], [0.85, 0.93, "cyan"]],
};
const COLOURS = { red: [255, 0, 0], green: [0, 255, 0], blue: [0, 0, 255], yellow: [255, 255, 0], magenta: [255, 0, 255], cyan: [0, 255, 255], grey: [128, 128, 128] };
const near = (px, name, tol = 40) => COLOURS[name].every((c, i) => Math.abs(c - px[i]) <= tol);
const preview = {};
for (const t of Object.keys(SAMPLE)) {
  preview[t] = await page.evaluate(async ([proj, tt, pts]) => window.harness.previewPixels(proj, Number(tt), pts), [main, t, SAMPLE[t].map(([x, y]) => [x, y])]);
}
await browser.close();
server.close();

/* ───────────── 6. Inspect the files ───────────── */
const probe = (file) => JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", file], { encoding: "utf8" }));
const { createFile, MP4BoxBuffer } = await import("mp4box");
function mp4boxInfo(file) {
  const bytes = readFileSync(file);
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const f = createFile();
  let info = null;
  f.onReady = (m) => (info = m);
  f.appendBuffer(MP4BoxBuffer.fromArrayBuffer(ab, 0));
  f.flush();
  const top = [];
  for (let at = 0; at + 8 <= bytes.length; ) {
    const size = bytes.readUInt32BE(at);
    top.push(bytes.toString("latin1", at + 4, at + 8));
    if (size < 8) break;
    at += size;
  }
  return { tracks: info.tracks.map((t) => ({ type: t.type, codec: t.codec, width: t.video?.width ?? null, height: t.video?.height ?? null, duration: t.duration / t.timescale })), duration: info.duration / info.timescale, faststart: top.indexOf("moov") < top.indexOf("mdat"), top };
}
/** One decoded frame at t as RGB, converted with the BT.709 limited-range matrix the file is tagged with. */
function frameAt(file, t, w, h) {
  const raw = execFileSync("ffmpeg", ["-v", "error", "-ss", String(t), "-i", file, "-frames:v", "1", "-vf", "scale=in_color_matrix=bt709:in_range=tv", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { maxBuffer: 64 * 1024 * 1024 });
  return { at: (x, y) => { const i = (Math.min(h - 1, Math.floor(y * h)) * w + Math.min(w - 1, Math.floor(x * w))) * 3; return [raw[i], raw[i + 1], raw[i + 2]]; }, raw, w, h };
}
/** Pixels in a horizontal band [y0, y1] that are near black and near white. */
function bandStats(fr, y0, y1) {
  let dark = 0, white = 0, n = 0;
  for (let y = Math.floor(y0 * fr.h); y < Math.floor(y1 * fr.h); y += 2)
    for (let x = 0; x < fr.w; x += 2) {
      const i = (y * fr.w + x) * 3;
      const [r, g, b] = [fr.raw[i], fr.raw[i + 1], fr.raw[i + 2]];
      n++;
      if (r < 40 && g < 40 && b < 40) dark++;
      if (r > 215 && g > 215 && b > 215) white++;
    }
  return { dark: dark / n, white: white / n };
}

const WANT = { "9:16": [1080, 1920], "4:5": [1080, 1350], "1:1": [1080, 1080], "16:9": [1920, 1080] };
const checks = [];
const check = (what, expected, observed, ok) => {
  checks.push({ what, expected, observed, ok });
  if (!ok) fails.push(`${what}: expected ${expected}, observed ${observed}`);
};
for (const [id, file] of Object.entries(files)) {
  const [w, h] = WANT[id];
  const p = probe(file);
  const v = p.streams.find((s) => s.codec_type === "video");
  const a = p.streams.find((s) => s.codec_type === "audio");
  const box = mp4boxInfo(file);
  report.renders[id].mp4box = box;
  report.renders[id].ffprobe = { video: { codec: v.codec_name, width: v.width, height: v.height, pix_fmt: v.pix_fmt, color_space: v.color_space, color_primaries: v.color_primaries, color_transfer: v.color_transfer, color_range: v.color_range, nb_frames: v.nb_frames }, audio: a ? { codec: a.codec_name, sample_rate: a.sample_rate, channels: a.channels } : null, duration: Number(p.format.duration) };
  const bt = box.tracks.find((t) => t.type === "video");
  check(`${id}: encoded size (mp4box)`, `${w}×${h}`, `${bt.width}×${bt.height}`, bt.width === w && bt.height === h);
  check(`${id}: encoded size (ffprobe)`, `${w}×${h}`, `${v.width}×${v.height}`, v.width === w && v.height === h);
  check(`${id}: audio track`, "present", a ? `${a.codec_name} ${a.sample_rate} Hz ${a.channels} ch` : "none", !!a);
  check(`${id}: moov before mdat`, "yes", box.faststart ? "yes" : "no", box.faststart);
  check(`${id}: colour tags`, "bt709 / bt709 / bt709 / tv", `${v.color_space} / ${v.color_primaries} / ${v.color_transfer} / ${v.color_range}`, v.color_space === "bt709" && v.color_primaries === "bt709" && v.color_transfer === "bt709" && v.color_range === "tv");
}
// The main render: length, trim and order, orientation, crop, text and logo.
{
  const file = files["9:16"];
  const dur = report.renders["9:16"].ffprobe.duration;
  check("9:16: length", "4.0 s (4 clips of 1 s)", `${dur.toFixed(2)} s`, Math.abs(dur - 4) < 0.1);
  const nb = Number(report.renders["9:16"].ffprobe.video.nb_frames);
  check("9:16: frames", "120 at 30 fps", String(nb), nb === 120);
  for (const [t, pts] of Object.entries(SAMPLE)) {
    const fr = frameAt(file, Number(t), 1080, 1920);
    pts.forEach(([x, y, name], i) => {
      const px = fr.at(x, y);
      check(`9:16 export at ${t}s (${x}, ${y})`, name, px.join(","), near(px, name));
      const pv = preview[t].pixels[i];
      check(`9:16 preview at ${t}s (${x}, ${y})`, name, pv.join(","), near(pv, name));
    });
  }
  const t05 = bandStats(frameAt(file, 0.5, 1080, 1920), 0.1, 0.14);
  const t15 = bandStats(frameAt(file, 1.5, 1080, 1920), 0.1, 0.14);
  const t25 = bandStats(frameAt(file, 2.5, 1080, 1920), 0.1, 0.14);
  check("English text box and letters at 0.5 s (band y 0.10–0.14)", "dark box > 20%, white letters > 3%", `dark ${(t05.dark * 100).toFixed(1)}%, white ${(t05.white * 100).toFixed(1)}%`, t05.dark > 0.2 && t05.white > 0.03);
  check("Arabic text box and letters at 1.5 s", "dark box > 20%, white letters > 3%", `dark ${(t15.dark * 100).toFixed(1)}%, white ${(t15.white * 100).toFixed(1)}%`, t15.dark > 0.2 && t15.white > 0.03);
  check("No text at 2.5 s (its layer ended)", "dark < 1%, white < 1%", `dark ${(t25.dark * 100).toFixed(1)}%, white ${(t25.white * 100).toFixed(1)}%`, t25.dark < 0.01 && t25.white < 0.01);
  // The music (220 Hz) is the sound: loud enough, not silence.
  const vd = execSync(`ffmpeg -hide_banner -i "${file}" -af volumedetect -f null - 2>&1 | grep mean_volume || true`, { encoding: "utf8" });
  const mean = Number((/mean_volume: (-?[\d.]+) dB/.exec(vd) ?? [])[1]);
  check("9:16: sound level (music track)", "mean above -30 dB", `${mean} dB`, mean > -30);
}
// The other frames: the crop is centred and nothing is stretched.
for (const [id, pts] of Object.entries({ "4:5": [[0.03, "red"], [0.5, "green"], [0.97, "blue"]], "1:1": [[0.03, "red"], [0.5, "green"], [0.97, "blue"]], "16:9": [[0.05, "red"], [0.5, "green"], [0.95, "blue"]] })) {
  const [w, h] = WANT[id];
  const fr = frameAt(files[id], 0.2, w, h);
  for (const [x, name] of pts) check(`${id}: crop at x ${x}`, name, fr.at(x, 0.5).join(","), near(fr.at(x, 0.5), name));
}
// The rotated clip's source report: what the engine read on import.
const rot = report.renders["9:16"].sources.find((s) => s.label === "rotated.mp4");
check("Phone clip: rotation read from the track header", "90", String(rot?.rotation), rot?.rotation === 90);
check("Phone clip: coded vs display size", "640×360 coded, 360×640 shown", rot ? `${rot.coded.width}×${rot.coded.height} coded, ${rot.display.width}×${rot.display.height} shown` : "none", rot?.coded.width === 640 && rot?.display.width === 360);
const bands = report.renders["9:16"].sources.find((s) => s.label === "bands.mp4");
check("Tagged clip: colour read from colr", "bt709 limited", bands?.colour ? `${bands.colour.matrix} ${bands.colour.fullRange ? "full" : "limited"}` : "none", bands?.colour?.matrix === "bt709" && bands?.colour?.fullRange === false);
report.checks = checks;
if (pageErrors.length) fails.push(...pageErrors.map((e) => `page error: ${e}`));

if (outDir) {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "render-9x16-vp9.mp4"), readFileSync(files["9:16"]));
  try {
    writeFileSync(join(outDir, "render-9x16-still.jpg"), readFileSync(files["9:16"].replace(/\.mp4$/, ".still.jpg")));
  } catch {
    /* no still */
  }
  ff("-i", files["9:16"], "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "26", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", join(outDir, "render-9x16-h264-transcode.mp4"));
  writeFileSync(join(outDir, "report.json"), JSON.stringify(report, null, 2));
}
rmSync(work, { recursive: true, force: true });
console.log(JSON.stringify({ renders: Object.fromEntries(Object.entries(report.renders).map(([k, v]) => [k, { ms: v.ms, bytes: v.bytes, ffprobe: v.ffprobe }])), checks: checks.map((c) => `${c.ok ? "ok  " : "FAIL"} ${c.what}: expected ${c.expected}, observed ${c.observed}`) }, null, 2));
if (fails.length) {
  console.error("FAILED:\n- " + fails.join("\n- "));
  process.exit(1);
}
console.log("OK");
