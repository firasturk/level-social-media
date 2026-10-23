/**
 * The video editor's AAC fallback, checked on real files in a branded Google Chrome that has H.264
 * in WebCodecs but no AAC AudioEncoder (Chrome on Linux): the editor's engine (the render-check
 * harness, scripts/video-render-check/harness.ts) renders with the studio's codecs, H.264 + AAC,
 * the AAC coming from the WebAssembly encoder, and the files are inspected with ffprobe/ffmpeg:
 *   - the streams: h264 High, aac LC 48 kHz stereo, moov before mdat, the sound track's edit list,
 *     start times, the two streams' lengths (equal within one AAC frame), a clean decode;
 *   - A/V sync on a made clip with a white flash frame and a 1 kHz beep at the same instants
 *     (1.0, 2.5, 4.0, 5.0 s): beep onset minus flash time, through the clip's own AAC sound and
 *     through a WAV music track (clip muted), must be within ±1 frame; the same measured with the
 *     edit list ignored shows what the edit list removes (the encoder's 1024 priming samples);
 *   - a dialogue clip (--talk) trimmed to 1–7 s: its rendered sound cross-correlated with the source's
 *     sound over the same span (peak lag and correlation);
 *   - the encoder's speed on 60 s of sound;
 *   - a blocked download of the encoder: the render stops with a plain message, and the next one works.
 *
 * Usage: node scripts/video-aac-fallback-check.mjs --chrome <chrome binary> --talk <H.264+AAC clip with speech> [--out dir] [--quick]
 * (--quick skips the 30 s drift render, five times the sync clip with 20 flash/beep pairs).
 * Needs ffmpeg/ffprobe on PATH. Prints a JSON report and "OK", or the failures.
 */
import { createServer } from "node:http";
import { execFileSync, execSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const opt = (name, fallback = null) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const chrome = opt("--chrome", process.env.CHROME);
const talk = opt("--talk");
const outDir = opt("--out");
if (!chrome || !talk) {
  console.error("Usage: node scripts/video-aac-fallback-check.mjs --chrome <chrome binary> --talk <clip.mp4> [--out dir]");
  process.exit(2);
}
const work = mkdtempSync(join(tmpdir(), "video-aac-fallback-"));
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

/* ───────────── 1. Fixtures ───────────── */
const FPS = 30;
const FLASHES = [1.0, 2.5, 4.0, 5.0];
const flashFrames = FLASHES.map((t) => Math.round(t * FPS));
const enable = flashFrames.map((n) => `eq(n\\,${n})`).join("+");
const beepExpr = `0.5*sin(2*PI*1000*t)*(${FLASHES.map((t) => `between(t\\,${t}\\,${(t + 1 / FPS).toFixed(6)})`).join("+")})`;
// The beep track alone (48 kHz stereo WAV) and the clip: black 640×360 at 30 fps with one white frame at each instant, H.264 + AAC (FFmpeg's encoder, with its own edit list).
ff("-f", "lavfi", "-i", `aevalsrc=${beepExpr}|${beepExpr}:s=48000:d=6`, "-c:a", "pcm_s16le", join(fx, "beep.wav"));
ff("-f", "lavfi", "-i", `color=c=black:s=640x360:r=${FPS}:d=6`, "-i", join(fx, "beep.wav"), "-vf", `drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable='${enable}',format=yuv420p`, "-c:v", "libx264", "-profile:v", "high", "-g", "30", "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2", "-movflags", "+faststart", join(fx, "sync.mp4"));
copyFileSync(talk, join(fx, "talk.mp4"));

/* ───────────── 2. The harness ───────────── */
const harnessOut = join(work, "harness");
await build({
  configFile: false,
  logLevel: "warn",
  root: join(root, "scripts", "video-render-check"),
  resolve: { alias: { "@": join(root, "src"), "@shared": join(root, "shared") } },
  build: { outDir: harnessOut, emptyOutDir: true, minify: false },
});
const MIME = { ".html": "text/html", ".js": "text/javascript", ".mp4": "video/mp4", ".wav": "audio/wav", ".wasm": "application/wasm" };
const requests = [];
const server = createServer((req, res) => {
  const path = decodeURIComponent((req.url ?? "/").split("?")[0]);
  requests.push(path);
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

/* ───────────── 3. Render in Chrome ───────────── */
const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"] });
const page = await browser.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));
await page.goto(url);
await page.waitForFunction(() => document.title === "ready", null, { timeout: 30000 });
const fails = [];
const report = { browser: browser.version(), capabilities: null, renders: {}, sync: {}, talk: null, bench: null };
report.capabilities = await page.evaluate(() => window.harness.capabilities());
const nativeAac = await page.evaluate(async () => !!(await AudioEncoder.isConfigSupported({ codec: "mp4a.40.2", sampleRate: 48000, numberOfChannels: 2, bitrate: 128000 }).catch(() => ({ supported: false }))).supported);
report.nativeAac = nativeAac;

for (const name of ["sync.mp4", "talk.mp4"]) await page.evaluate(async ([n, u]) => window.harness.addSource(n, u), [name, `/fx/${name}`]);
await page.evaluate(async (u) => window.harness.setMusic(u), "/fx/beep.wav");

const project = (name, clips, extra = {}) => ({
  v: 3, rev: 1, createdAt: 1, updatedAt: 1, name, clips, look: "none",
  colour: { exposure: 0, contrast: 0, saturation: 0, temperature: 0, tint: 0, highlights: 0, shadows: 0 },
  lut: null, music: null, voices: [], output: { width: 1080, height: 1920, fps: FPS, bitrate: 4_000_000 }, snapToBeats: false,
  framing: { fit: "fit", zoom: 1, x: 0, y: 0 }, background: "#000000", overlays: [], ...extra,
});
const clip = (id, name, duration, inPt, outPt, more = {}) => ({ id, source: { kind: "upload", name, size: 0 }, duration, in: inPt, out: outPt, speed: 1, transition: "cut", transitionDuration: 0.5, ...more });
const renders = {
  "clip-sound": project("Sync: the clip's own sound", [clip("s1", "sync.mp4", 6, 0, 6)]),
  "music-wav": project("Sync: beep as music, clip muted", [clip("s1", "sync.mp4", 6, 0, 6, { muted: true })], { music: { source: { kind: "upload", name: "beep.wav", size: 0 }, offset: 0, volume: 1, fadeIn: 0, fadeOut: 0 } }),
  talk: project("Dialogue 1–7 s", [clip("t1", "talk.mp4", 8, 1, 7)]),
};
// Drift: the sync clip five times in a row (30 s, 20 flash/beep pairs), unless --quick.
const LONG = [0, 1, 2, 3, 4].flatMap((k) => FLASHES.map((t) => k * 6 + t));
if (!args.includes("--quick")) renders["long-30s"] = project("Sync over 30 s", [0, 1, 2, 3, 4].map((k) => clip(`l${k}`, "sync.mp4", 6, 0, 6)));
const files = {};
for (const [id, p] of Object.entries(renders)) {
  const r = await page.evaluate(async (proj) => window.harness.render(proj, "studio"), p);
  const file = join(work, `${id}.mp4`);
  writeFileSync(file, Buffer.from(r.mp4, "base64"));
  files[id] = file;
  report.renders[id] = { ms: r.ms, phases: r.phases, bytes: Buffer.from(r.mp4, "base64").length, engine: { width: r.width, height: r.height, duration: r.duration, frames: r.frames, videoCodec: r.videoCodec, audioEncoder: r.audioEncoder } };
}
report.bench = await page.evaluate(() => window.harness.aacBench(60));
report.wasmRequests = requests.filter((p) => p.endsWith(".wasm"));

// A failed download of the encoder: the render stops with a plain message, and the next render (download allowed) works.
{
  const fresh = await browser.newPage();
  fresh.on("pageerror", (e) => pageErrors.push(String(e)));
  await fresh.route("**/*.wasm", (r) => r.abort("internetdisconnected"));
  await fresh.goto(url);
  await fresh.waitForFunction(() => document.title === "ready", null, { timeout: 30000 });
  await fresh.evaluate(async (u) => window.harness.addSource("sync.mp4", u), "/fx/sync.mp4");
  const short = project("One second", [clip("s1", "sync.mp4", 6, 0, 1)]);
  const failed = await fresh.evaluate(async (proj) => window.harness.render(proj, "studio").then(() => "rendered", (e) => String(e.message ?? e)), short);
  await fresh.unroute("**/*.wasm");
  const again = await fresh.evaluate(async (proj) => window.harness.render(proj, "studio").then((r) => `rendered ${r.frames} frames, audio ${r.audioEncoder}`, (e) => `failed: ${e.message ?? e}`), short);
  report.recovery = { blocked: failed, retried: again };
  await fresh.close();
}
await browser.close();
server.close();

/* ───────────── 4. Inspect ───────────── */
const checks = [];
const check = (what, expected, observed, ok) => {
  checks.push({ what, expected, observed, ok });
  if (!ok) fails.push(`${what}: expected ${expected}, observed ${observed}`);
};
const probe = (file, extra = []) => JSON.parse(execFileSync("ffprobe", ["-v", "error", ...extra, "-show_streams", "-show_format", "-of", "json", file], { encoding: "utf8" }));
function topBoxes(file) {
  const b = readFileSync(file);
  const out = [];
  for (let at = 0; at + 8 <= b.length; ) {
    const size = b.readUInt32BE(at);
    out.push({ type: b.toString("latin1", at + 4, at + 8), at, size });
    if (size < 8) break;
    at += size;
  }
  return out;
}
/** The sound track's edit list (segment duration in the movie timescale, media time in samples), read from the boxes. */
function soundEdit(file) {
  const b = readFileSync(file);
  const kids = (from, to) => {
    const out = [];
    for (let at = from; at + 8 <= to; ) {
      const size = b.readUInt32BE(at);
      out.push({ type: b.toString("latin1", at + 4, at + 8), at, size });
      at += size;
    }
    return out;
  };
  const moov = topBoxes(file).find((x) => x.type === "moov");
  for (const trak of kids(moov.at + 8, moov.at + moov.size).filter((x) => x.type === "trak")) {
    const k = kids(trak.at + 8, trak.at + trak.size);
    const mdia = k.find((x) => x.type === "mdia");
    const hdlr = kids(mdia.at + 8, mdia.at + mdia.size).find((x) => x.type === "hdlr");
    if (b.toString("latin1", hdlr.at + 16, hdlr.at + 20) !== "soun") continue;
    const edts = k.find((x) => x.type === "edts");
    if (!edts) return null;
    const elst = kids(edts.at + 8, edts.at + edts.size).find((x) => x.type === "elst");
    return { entries: b.readUInt32BE(elst.at + 12), segment: b.readUInt32BE(elst.at + 16), mediaTime: b.readInt32BE(elst.at + 20) };
  }
  return null;
}
const decodeErrors = (file) => spawnSync("ffmpeg", ["-v", "error", "-i", file, "-f", "null", "-"], { encoding: "utf8" }).stderr.trim();
/** Mean luma (0–255) of the centre of each decoded frame (a 16×16 grey thumbnail of the middle eighth: the clip sits there in Fit). */
function frameLuma(file) {
  const raw = execFileSync("ffmpeg", ["-v", "error", "-i", file, "-map", "0:v:0", "-vf", "crop=iw/2:ih/8,scale=16:16,format=gray", "-f", "rawvideo", "-"], { maxBuffer: 1 << 28 });
  const out = [];
  for (let i = 0; i + 256 <= raw.length; i += 256) {
    let s = 0;
    for (let j = 0; j < 256; j++) s += raw[i + j];
    out.push(s / 256);
  }
  return out;
}
/** The first audio stream as mono 48 kHz floats (from its first presented sample). */
function pcm(file, extraIn = [], extraOut = []) {
  const raw = execFileSync("ffmpeg", ["-v", "error", ...extraIn, "-i", file, ...extraOut, "-map", "0:a:0", "-ac", "1", "-ar", "48000", "-f", "f32le", "-"], { maxBuffer: 1 << 28 });
  return new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
}
/** Onset of the beep near `t` (s): the first sample above a quarter of the beep's peak in [t−0.2, t+0.2]. */
function onsetNear(x, t, rate = 48000) {
  const a = Math.max(0, Math.round((t - 0.2) * rate));
  const b = Math.min(x.length, Math.round((t + 0.2) * rate));
  let peak = 0;
  for (let i = a; i < b; i++) peak = Math.max(peak, Math.abs(x[i]));
  for (let i = a; i < b; i++) if (Math.abs(x[i]) >= peak / 4) return i / rate;
  return NaN;
}
function syncOf(file, ignoreEditList = false, expected = FLASHES) {
  const p = probe(file, ignoreEditList ? ["-ignore_editlist", "1"] : []);
  const v = p.streams.find((s) => s.codec_type === "video");
  const a = p.streams.find((s) => s.codec_type === "audio");
  const luma = frameLuma(file);
  const flashes = luma.map((l, i) => [l, i]).filter(([l]) => l > 128).map(([, i]) => Number(v.start_time) + i / FPS);
  const x = pcm(file, ignoreEditList ? ["-ignore_editlist", "1"] : []);
  const audioStart = Number(a.start_time);
  return expected.map((t) => {
    const flash = flashes.reduce((best, f) => (Math.abs(f - t) < Math.abs(best - t) ? f : best), Infinity);
    const onset = audioStart + onsetNear(x, t - audioStart);
    return { expected: t, flash: Number(flash.toFixed(4)), beep: Number(onset.toFixed(4)), offsetMs: Number(((onset - flash) * 1000).toFixed(2)) };
  });
}

for (const [id, file] of Object.entries(files)) {
  const p = probe(file);
  const v = p.streams.find((s) => s.codec_type === "video");
  const a = p.streams.find((s) => s.codec_type === "audio");
  const top = topBoxes(file).map((x) => x.type);
  const edit = soundEdit(file);
  const r = report.renders[id];
  r.ffprobe = {
    video: { codec: v.codec_name, profile: v.profile, level: v.level, pix_fmt: v.pix_fmt, width: v.width, height: v.height, start_time: Number(v.start_time), duration: Number(v.duration), nb_frames: Number(v.nb_frames) },
    audio: a ? { codec: a.codec_name, profile: a.profile, sample_rate: Number(a.sample_rate), channels: a.channels, start_time: Number(a.start_time), duration: Number(a.duration), bit_rate: Number(a.bit_rate) } : null,
    format: { duration: Number(p.format.duration), boxes: top },
  };
  r.edit = edit;
  r.decodeErrors = decodeErrors(file);
  check(`${id}: audio encoded by`, "wasm (no native AAC in this Chrome)", r.engine.audioEncoder, r.engine.audioEncoder === (nativeAac ? "native" : "wasm"));
  check(`${id}: video`, "h264 High yuv420p 1080×1920", `${v.codec_name} ${v.profile} ${v.pix_fmt} ${v.width}×${v.height}`, v.codec_name === "h264" && v.profile === "High" && v.pix_fmt === "yuv420p" && v.width === 1080 && v.height === 1920);
  check(`${id}: audio`, "aac LC 48000 Hz 2 ch", a ? `${a.codec_name} ${a.profile} ${a.sample_rate} Hz ${a.channels} ch` : "none", !!a && a.codec_name === "aac" && a.profile === "LC" && a.sample_rate === "48000" && a.channels === 2);
  check(`${id}: moov before mdat`, "yes", top.join(" "), top.indexOf("moov") >= 0 && top.indexOf("moov") < top.indexOf("mdat"));
  check(`${id}: sound edit list`, "1 entry, media time 1024", edit ? `${edit.entries} entry, media time ${edit.mediaTime}, ${edit.segment} ms` : "none", !!edit && edit.entries === 1 && edit.mediaTime === 1024);
  check(`${id}: start times`, "0 / 0", `${v.start_time} / ${a?.start_time}`, Number(v.start_time) === 0 && Number(a?.start_time) === 0);
  const dv = Number(v.duration);
  const da = Number(a?.duration);
  check(`${id}: stream lengths within one AAC frame (21.3 ms)`, `|video − audio| ≤ 21.3 ms`, `${dv.toFixed(4)} s / ${da.toFixed(4)} s (${((da - dv) * 1000).toFixed(1)} ms)`, Math.abs(da - dv) <= 1024 / 48000 + 1e-6);
  check(`${id}: clean decode`, "no errors", r.decodeErrors || "none", !r.decodeErrors);
}

// A/V sync: the source itself, the two renders, and the renders with their edit list ignored.
const frameMs = 1000 / FPS;
report.sync.source = syncOf(join(fx, "sync.mp4"));
for (const id of ["clip-sound", "music-wav"]) {
  report.sync[id] = syncOf(files[id]);
  report.sync[`${id} (edit list ignored)`] = syncOf(files[id], true);
  for (const s of report.sync[id]) check(`${id}: beep − flash at ${s.expected} s`, `within ±${frameMs.toFixed(1)} ms`, `${s.offsetMs} ms`, Math.abs(s.offsetMs) <= frameMs);
}
if (files["long-30s"]) {
  const long = syncOf(files["long-30s"], false, LONG);
  report.sync["long-30s"] = long;
  const offs = long.map((s) => s.offsetMs);
  check("long-30s: beep − flash over 20 pairs (0–30 s)", `all within ±${frameMs.toFixed(1)} ms, no drift`, `min ${Math.min(...offs)} ms, max ${Math.max(...offs)} ms, first ${offs[0]} ms, last ${offs.at(-1)} ms`, offs.every((o) => Math.abs(o) <= frameMs) && Math.abs(offs.at(-1) - offs[0]) < 1);
}

// Dialogue: the rendered sound against the source's over the same span (source 1–7 s = output 0–6 s).
{
  const out = pcm(files.talk);
  const src = pcm(join(fx, "talk.mp4"), ["-ss", "1", "-t", "6"]);
  const from = 48000;
  const n = 48000 * 4; // output 1–5 s, inside both
  const maxLag = 2400; // ±50 ms
  let best = { lag: 0, r: -2 };
  let r0 = 0;
  const energy = (x, a) => {
    let s = 0;
    for (let i = 0; i < n; i++) s += x[a + i] * x[a + i];
    return Math.sqrt(s);
  };
  const eo = energy(out, from);
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += out[from + i] * src[from + i + lag];
    const r = s / (eo * energy(src, from + lag) || 1);
    if (lag === 0) r0 = r;
    if (r > best.r) best = { lag, r };
  }
  report.talk = { peakLagSamples: best.lag, peakLagMs: Number(((best.lag / 48000) * 1000).toFixed(3)), peakCorrelation: Number(best.r.toFixed(4)), correlationAtZero: Number(r0.toFixed(4)), note: "positive lag: the render's sound is late against the source" };
  check("talk: cross-correlation peak lag", "within ±1 frame (±1600 samples), ideally 0", `${best.lag} samples (${report.talk.peakLagMs} ms), r = ${report.talk.peakCorrelation}`, Math.abs(best.lag) <= 1600 && best.r > 0.9);
}
check("WebAssembly encoder downloaded", "once, only by the fallback", report.wasmRequests.join(", ") || "never", report.wasmRequests.length === 1);
check("encoder download blocked: the render stops with a plain message", "“The audio encoder could not be downloaded …”", report.recovery.blocked, /^The audio encoder could not be downloaded/.test(report.recovery.blocked));
check("then a second render with the download allowed", "renders, audio wasm", report.recovery.retried, /^rendered \d+ frames, audio wasm$/.test(report.recovery.retried));
if (pageErrors.length) fails.push(...pageErrors.map((e) => `page error: ${e}`));
report.checks = checks;

if (outDir) {
  mkdirSync(outDir, { recursive: true });
  for (const [id, file] of Object.entries(files)) copyFileSync(file, join(outDir, `render-${id}.mp4`));
  copyFileSync(join(fx, "sync.mp4"), join(outDir, "fixture-sync.mp4"));
  writeFileSync(join(outDir, "report.json"), JSON.stringify(report, null, 2));
}
rmSync(work, { recursive: true, force: true });
console.log(JSON.stringify({ browser: report.browser, nativeAac, capabilities: report.capabilities, recovery: report.recovery, renders: Object.fromEntries(Object.entries(report.renders).map(([k, v]) => [k, { ms: v.ms, phases: v.phases, ffprobe: v.ffprobe, edit: v.edit }])), sync: report.sync, talk: report.talk, bench: report.bench, checks: checks.map((c) => `${c.ok ? "ok  " : "FAIL"} ${c.what}: expected ${c.expected}, observed ${c.observed}`) }, null, 2));
if (fails.length) {
  console.error("FAILED:\n- " + fails.join("\n- "));
  process.exit(1);
}
console.log("OK");
