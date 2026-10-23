/**
 * Phase 2 of the video editor, checked on a real rendered file: the editor's engine (the same
 * harness as scripts/video-render-check.mjs) in headless Chromium renders a project edited with
 * the editor's own timeline functions, and the file is inspected with ffprobe/ffmpeg.
 *
 * The project: clip A (red second, then green second; a 440 Hz tone) split at 2 s and its first
 * half ripple-deleted (the text that sat on the green half moves left with it); clip B (blue,
 * 660 Hz) joined by a 0.5 s crossfade; clip C (yellow, 880 Hz, muted) joined by a dip to black;
 * a bilingual text layer (Arabic over English, Tajawal, the studio's Arabic font) fading in and
 * rising with keyframes; a logo whose scale is keyframed 0.5 → 1.5; music (220 Hz) with a fade in
 * and out, mixed with the clips' own sound (A at 50 %, B at 100 %, C muted) and ducked under a
 * voice-over (1 kHz) from 3.0 to 4.5 s.
 *
 * Open-source Chromium has no H.264 or AAC, so the render uses the engine's test codecs (VP9 +
 * Opus in MP4); everything else is the studio's path.
 *
 * Usage:  node scripts/video-phase2-check.mjs --out <dir>   (ffmpeg/ffprobe and curl on PATH)
 * Writes render.mp4, frame PNGs at the checked times, preview PNGs and report.json (expected vs
 * observed) to <dir>; prints the checks and "OK", or the failures.
 */
import { createServer } from "node:http";
import { execFileSync, execSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const outDir = args.includes("--out") ? args[args.indexOf("--out") + 1] : join(tmpdir(), "video-phase2");
mkdirSync(outDir, { recursive: true });
const work = mkdtempSync(join(tmpdir(), "video-phase2-"));
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
const VP9 = ["-c:v", "libvpx-vp9", "-b:v", "600k", "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-color_range", "tv"];
const OPUS = ["-c:a", "libopus", "-b:a", "96k", "-ac", "2", "-ar", "48000"];
// A: red second then green second, 440 Hz.
ff("-f", "lavfi", "-i", "color=c=red:s=640x360:r=30:d=2", "-f", "lavfi", "-i", "color=c=0x00ff00:s=640x360:r=30:d=2", "-f", "lavfi", "-i", "sine=f=440:d=4",
  "-filter_complex", "[0][1]concat=n=2:v=1:a=0,scale=out_color_matrix=bt709:out_range=tv,format=yuv420p[v]", "-map", "[v]", "-map", "2:a", ...VP9, ...OPUS, join(fx, "a.mp4"));
// B: blue, 660 Hz.
ff("-f", "lavfi", "-i", "color=c=blue:s=640x360:r=30:d=3", "-f", "lavfi", "-i", "sine=f=660:d=3", "-vf", "scale=out_color_matrix=bt709:out_range=tv,format=yuv420p", ...VP9, ...OPUS, join(fx, "b.mp4"));
// C: yellow, 880 Hz (muted on the timeline).
ff("-f", "lavfi", "-i", "color=c=yellow:s=640x360:r=30:d=2", "-f", "lavfi", "-i", "sine=f=880:d=2", "-vf", "scale=out_color_matrix=bt709:out_range=tv,format=yuv420p", ...VP9, ...OPUS, join(fx, "c.mp4"));
ff("-f", "lavfi", "-i", "color=c=cyan:s=200x100:d=1", "-frames:v", "1", join(fx, "logo.png"));
ff("-f", "lavfi", "-i", "sine=f=220:d=8", "-ac", "2", "-ar", "48000", join(fx, "music.wav"));
ff("-f", "lavfi", "-i", "sine=f=1000:d=1.5", "-ac", "2", "-ar", "48000", join(fx, "voice.wav"));
// The studio's Arabic font (Tajawal, the face index.html loads from Google Fonts), served locally to the page.
const css = execFileSync("curl", ["-sS", "-A", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36", "https://fonts.googleapis.com/css2?family=Tajawal:wght@800&display=swap"], { encoding: "utf8" });
const fontFaces = [];
for (const m of css.matchAll(/\/\* ([a-z-]+) \*\/\s*@font-face \{([^}]*)\}/g)) {
  const [, subset, body] = m;
  if (subset !== "arabic" && subset !== "latin") continue;
  const url = /url\((https:[^)]+)\)/.exec(body)[1];
  const range = /unicode-range: ([^;]+);/.exec(body)[1];
  execFileSync("curl", ["-sS", "-o", join(fx, `tajawal-${subset}.woff2`), url]);
  fontFaces.push(`@font-face { font-family: "Tajawal"; font-weight: 800; src: url(/fx/tajawal-${subset}.woff2) format("woff2"); unicode-range: ${range}; }`);
}

/* ───────────── 2. The harness, built and served ───────────── */
const harnessOut = join(work, "harness");
await build({ configFile: false, logLevel: "warn", root: join(root, "scripts", "video-render-check"), resolve: { alias: { "@": join(root, "src"), "@shared": join(root, "shared") } }, build: { outDir: harnessOut, emptyOutDir: true, minify: false } });
const MIME = { ".html": "text/html", ".js": "text/javascript", ".mp4": "video/mp4", ".png": "image/png", ".wav": "audio/wav", ".woff2": "font/woff2" };
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

/* ───────────── 3. Edit and render in the browser ───────────── */
const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || "/opt/pw-browsers/chromium", headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
const page = await browser.newPage({ viewport: { width: 800, height: 900 } });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));
await page.goto(url);
await page.waitForFunction(() => document.title === "ready", null, { timeout: 30000 });
await page.addStyleTag({ content: fontFaces.join("\n") });
const fontReady = await page.evaluate(async () => {
  await document.fonts.load('800 48px "Tajawal"', "عرض خاص Special offer");
  return document.fonts.check('800 48px "Tajawal"', "عرض خاص");
});
for (const n of ["a.mp4", "b.mp4", "c.mp4"]) await page.evaluate(async ([name, u]) => window.harness.addSource(name, u), [n, `/fx/${n}`]);
await page.evaluate(async () => window.harness.setMusic("/fx/music.wav"));
await page.evaluate(async () => window.harness.setVoice("vo", "/fx/voice.wav"));
const logo = `data:image/png;base64,${readFileSync(join(fx, "logo.png")).toString("base64")}`;

const edited = await page.evaluate((logoSrc) => {
  const o = window.harness.ops;
  const src = (name) => ({ kind: "upload", name, size: 0 });
  const zero = { exposure: 0, contrast: 0, saturation: 0, temperature: 0, tint: 0, highlights: 0, shadows: 0 };
  let p = {
    v: 2, rev: 1, createdAt: 1, updatedAt: 1, name: "Phase 2 check", look: "none", colour: zero, lut: null,
    output: { width: 1080, height: 1920, fps: 30, bitrate: 4_000_000 }, snapToBeats: false, framing: { fit: "fill", zoom: 1, x: 0, y: 0 }, background: "#000000",
    clips: [
      { ...o.newClip(src("a.mp4"), 4, "A"), volume: 0.5 },
      { ...o.newClip(src("b.mp4"), 3, "B"), transition: "crossfade", transitionDuration: 0.5 },
      { ...o.newClip(src("c.mp4"), 2, "C"), transition: "dipBlack", transitionDuration: 0.6, muted: true },
    ],
    overlays: [
      // On the green half of A (timeline 2.3 – 5.0 before the edit): fades in and rises over its first half second.
      { id: "t1", kind: "text", text: "عرض خاص", second: "Special offer", start: 2.3, end: 5.0, x: 0.5, y: 0.2, size: 0.05, color: "#ffffff", font: "sans", weight: 800, align: "center", box: "#000000", width: 0.86,
        keyframes: { opacity: [{ t: 0, v: 0, ease: "linear" }, { t: 0.5, v: 1, ease: "linear" }], y: [{ t: 0, v: 0.25, ease: "linear" }, { t: 0.5, v: 0.2, ease: "linear" }] } },
      { id: "l1", kind: "logo", src: logoSrc, name: "Logo", start: 0, end: 30, x: 0.85, y: 0.9, width: 0.15, opacity: 1, keyframes: { scale: [{ t: 0, v: 0.5, ease: "linear" }, { t: 6, v: 1.5, ease: "linear" }] } },
    ],
    music: { source: src("music.wav"), offset: 0, volume: 0.8, fadeIn: 1, fadeOut: 1, duration: 8, start: 0, duck: { enabled: true, level: 0.2 } },
    voices: [{ id: "vo", source: src("voice.wav"), name: "Voice", start: 5.0, in: 0, out: 1.5, duration: 1.5, volume: 1 }],
  };
  const steps = [];
  // Split A at 2 s (the red | green boundary), then ripple-delete the red half.
  const s = o.splitAt(p.clips, 2, ["A"]);
  p = { ...p, clips: s.clips };
  steps.push(`split A at 2.0 s → ${p.clips.length} clips`);
  p = o.deleteClips(p, ["A"], true);
  steps.push(`ripple delete of A's first half → text at ${p.overlays[0].start}–${p.overlays[0].end} s, voice at ${p.voices[0].start} s`);
  // The logo spans the cut.
  p.overlays[1] = { ...p.overlays[1], end: 6.5 };
  return { project: p, steps };
}, logo);
const project = edited.project;

const t0 = Date.now();
const r = await page.evaluate(async (proj) => window.harness.render(proj), project);
const renderMs = Date.now() - t0;
const file = join(outDir, "render.mp4");
writeFileSync(file, Buffer.from(r.mp4, "base64"));
if (r.still) writeFileSync(join(outDir, "render-still.jpg"), Buffer.from(r.still, "base64"));

// The preview (the same compositor, hidden <video> elements) at the same times and points.
const PREVIEW = { 1.0: [[0.5, 0.6], [0.5, 0.2]], 1.75: [[0.5, 0.6]], 4.5: [[0.5, 0.6]], 5.0: [[0.85, 0.9]] };
const preview = {};
for (const t of Object.keys(PREVIEW)) preview[t] = await page.evaluate(async ([proj, tt, pts]) => window.harness.previewPixels(proj, Number(tt), pts), [project, t, PREVIEW[t]]);
// The preview's canvas at two times, saved as PNGs to look at next to the render's frames.
for (const t of [0.55, 1.0]) {
  const dataUrl = await page.evaluate(async ([proj, tt]) => window.harness.previewPng(proj, tt), [project, t]);
  writeFileSync(join(outDir, `preview-${t.toFixed(2)}s.png`), Buffer.from(dataUrl.split(",")[1], "base64"));
}
await browser.close();
server.close();

/* ───────────── 4. Inspect the file ───────────── */
const checks = [];
const fails = [];
const check = (what, expected, observed, ok) => {
  checks.push({ what, expected, observed, ok });
  if (!ok) fails.push(`${what}: expected ${expected}, observed ${observed}`);
};
const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", file], { encoding: "utf8" }));
const v = probe.streams.find((s) => s.codec_type === "video");
const a = probe.streams.find((s) => s.codec_type === "audio");
const W = 1080;
const H = 1920;
const length = 6.5;
check("Edits applied with the editor's functions", "split + ripple delete: 3 clips, text moved from 2.3 s to 0.3 s", `${project.clips.length} clips (${project.clips.map((c) => c.source.name).join(", ")}), text ${project.overlays[0].start}–${project.overlays[0].end} s`, project.clips.length === 3 && Math.abs(project.overlays[0].start - 0.3) < 1e-6);
check("Encoded size (ffprobe)", `${W}×${H}`, `${v.width}×${v.height}`, v.width === W && v.height === H);
check("Duration matches the timeline", `${length} s (green 2 s + blue 3 s − 0.5 s crossfade + yellow 2 s), ${length * 30} frames`, `${Number(probe.format.duration).toFixed(2)} s, ${v.nb_frames} frames`, Math.abs(Number(probe.format.duration) - length) < 0.1 && Number(v.nb_frames) === length * 30);
check("Audio track", "present", a ? `${a.codec_name} ${a.sample_rate} Hz ${a.channels} ch` : "none", !!a);

const frameAt = (t) => {
  const raw = execFileSync("ffmpeg", ["-v", "error", "-ss", String(t), "-i", file, "-frames:v", "1", "-vf", "scale=in_color_matrix=bt709:in_range=tv", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { maxBuffer: 64 * 1024 * 1024 });
  return { raw, at: (x, y) => { const i = (Math.min(H - 1, Math.floor(y * H)) * W + Math.min(W - 1, Math.floor(x * W))) * 3; return [raw[i], raw[i + 1], raw[i + 2]]; } };
};
const savePng = (t, name) => ff("-ss", String(t), "-i", file, "-frames:v", "1", "-vf", "scale=in_color_matrix=bt709:in_range=tv", join(outDir, name));
const near = (px, c, tol = 40) => c.every((x, i) => Math.abs(x - px[i]) <= tol);
/** Rows in the band y0 … y1 where the text's black box is (most of the middle of the row dark), and their centre. */
function boxRows(fr, y0, y1, dark = 40) {
  const rows = [];
  for (let y = Math.floor(y0 * H); y < Math.floor(y1 * H); y++) {
    let n = 0;
    for (let x = 300; x < 780; x += 4) {
      const i = (y * W + x) * 3;
      if (fr.raw[i] < dark && fr.raw[i + 1] < dark && fr.raw[i + 2] < dark) n++;
    }
    if (n > 40) rows.push(y);
  }
  return { rows: rows.length, centre: rows.length ? rows.reduce((s, y) => s + y, 0) / rows.length : null };
}
/** Pixels in the box band that are the half-transparent box over green (opacity ~0.5). */
function halfBox(fr, y0, y1) {
  let n = 0;
  let tot = 0;
  for (let y = Math.floor(y0 * H); y < Math.floor(y1 * H); y += 2)
    for (let x = 300; x < 780; x += 4) {
      const i = (y * W + x) * 3;
      tot++;
      if (fr.raw[i] < 40 && fr.raw[i + 1] > 90 && fr.raw[i + 1] < 170 && fr.raw[i + 2] < 40) n++;
    }
  return n / tot;
}
/** The cyan logo's width in pixels on its centre row. */
function cyanRun(fr, y) {
  const row = Math.floor(y * H);
  let best = 0;
  let run = 0;
  for (let x = 0; x < W; x++) {
    const i = (row * W + x) * 3;
    const isCyan = fr.raw[i] < 60 && fr.raw[i + 1] > 200 && fr.raw[i + 2] > 200;
    run = isCyan ? run + 1 : 0;
    best = Math.max(best, run);
  }
  return best;
}

// Text: invisible at its first frame (opacity keyframe 0), half at 0.55 s, whole at 1.0 s and higher up (y keyframe 0.25 → 0.2).
const f030 = frameAt(0.3);
const f055 = frameAt(0.55);
const f100 = frameAt(1.0);
const f350 = frameAt(3.5);
savePng(0.3, "frame-0.30s-text-opacity0.png");
savePng(0.55, "frame-0.55s-text-half.png");
savePng(1.0, "frame-1.00s-text-full.png");
savePng(1.75, "frame-1.75s-crossfade.png");
savePng(3.5, "frame-3.50s-text-gone.png");
savePng(4.35, "frame-4.35s-dip-half.png");
savePng(4.5, "frame-4.50s-dip-black.png");
savePng(5.0, "frame-5.00s-logo-large.png");
const b030 = boxRows(f030, 0.12, 0.32);
const b100 = boxRows(f100, 0.12, 0.32);
check("Text at 0.30 s (its start, opacity keyframe 0)", "no box rows", `${b030.rows} rows`, b030.rows === 0);
const h055 = halfBox(f055, 0.15, 0.3);
check("Text at 0.55 s (opacity 0.5 by the keyframes)", "half-dark box over green > 5 % of the band", `${(h055 * 100).toFixed(1)} %`, h055 > 0.05);
check("Text at 1.00 s (opacity 1)", "two lines of black box (> 100 rows)", `${b100.rows} rows`, b100.rows > 100);
const want100 = 0.2 * H;
check("Text position at 1.00 s (y keyframe 0.25 → 0.20, done)", `box centred at y ≈ ${want100} px`, b100.centre === null ? "none" : `${b100.centre.toFixed(0)} px`, b100.centre !== null && Math.abs(b100.centre - want100) < 20);
const b055 = (() => {
  // The half-transparent box at 0.55 s: centre of the rows where it shows.
  const rows = [];
  for (let y = Math.floor(0.12 * H); y < Math.floor(0.36 * H); y++) {
    let n = 0;
    for (let x = 300; x < 780; x += 4) {
      const i = (y * W + x) * 3;
      if (f055.raw[i] < 40 && f055.raw[i + 1] > 90 && f055.raw[i + 1] < 170) n++;
    }
    if (n > 40) rows.push(y);
  }
  return rows.length ? rows.reduce((s, y) => s + y, 0) / rows.length : null;
})();
const want055 = 0.225 * H;
check("Text position at 0.55 s (half way: y 0.225)", `box centred at y ≈ ${want055} px`, b055 === null ? "none" : `${b055.toFixed(0)} px`, b055 !== null && Math.abs(b055 - want055) < 20);
const b350 = boxRows(f350, 0.12, 0.32);
check("No text at 3.50 s (the layer ended at 3.0 s after the ripple)", "no box rows", `${b350.rows} rows`, b350.rows === 0);
// Pictures: green first (the red half was deleted), the crossfade, the dip, the yellow clip.
check("0.30 s: the green half (the red half was ripple-deleted)", "green", f030.at(0.5, 0.6).join(","), near(f030.at(0.5, 0.6), [0, 255, 0]));
const fx175 = frameAt(1.75).at(0.5, 0.6);
check("1.75 s: crossfade half way, green → blue", "≈ 0,128,128", fx175.join(","), near(fx175, [0, 128, 128], 30));
const fx435 = frameAt(4.35).at(0.5, 0.6);
check("4.35 s: dip to black half way (blue at half)", "≈ 0,0,128", fx435.join(","), near(fx435, [0, 0, 128], 35));
const fx45 = frameAt(4.5).at(0.5, 0.6);
check("4.50 s: the cut, dipped fully to black", "≈ 0,0,0", fx45.join(","), near(fx45, [0, 0, 0], 20));
const fx55 = frameAt(5.5).at(0.5, 0.6);
check("5.50 s: the yellow clip", "yellow", fx55.join(","), near(fx55, [255, 255, 0]));
// Logo scale keyframes: width = 0.15 × 1080 × scale(t), scale 0.5 → 1.5 over 6 s.
for (const t of [1.0, 5.0]) {
  const want = 0.15 * W * (0.5 + t / 6);
  const got = cyanRun(frameAt(t), 0.9);
  check(`Logo width at ${t.toFixed(2)} s (scale keyframe ${(0.5 + t / 6).toFixed(3)})`, `${want.toFixed(0)} px`, `${got} px`, Math.abs(got - want) <= 4);
}
// Preview against the render, at the same times (the same compositor).
const px = (t, i) => preview[String(t)]?.pixels[i] ?? preview[t]?.pixels[i];
check("Preview at 1.75 s (crossfade)", fx175.join(","), px("1.75", 0)?.join(","), !!px("1.75", 0) && near(px("1.75", 0), fx175, 30));
check("Preview at 4.50 s (dip)", fx45.join(","), px("4.5", 0)?.join(","), !!px("4.5", 0) && near(px("4.5", 0), fx45, 25));
check("Preview at 5.00 s (logo centre)", "cyan", px("5", 0)?.join(","), !!px("5", 0) && near(px("5", 0), [0, 255, 255], 40));
check("Preview at 1.00 s (text box)", "dark (the text's box)", px("1", 1)?.join(","), !!px("1", 1) && px("1", 1).every((c) => c < 90));

/* ───────────── 5. The sound: tones measured with a Goertzel filter ───────────── */
const pcm = execFileSync("ffmpeg", ["-v", "error", "-i", file, "-f", "f32le", "-ac", "1", "-ar", "48000", "-"], { maxBuffer: 64 * 1024 * 1024 });
const samples = new Float32Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 4));
const amp = (f, t0, t1) => {
  const a0 = Math.floor(t0 * 48000);
  const n = Math.floor((t1 - t0) * 48000);
  const k = (2 * Math.PI * f) / 48000;
  const coeff = 2 * Math.cos(k);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < n; i++) {
    const s = samples[a0 + i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s;
  }
  const power = s1 * s1 + s2 * s2 - coeff * s1 * s2;
  return (2 * Math.sqrt(Math.max(0, power))) / n;
};
const TONE = 0.125; // ffmpeg's sine source amplitude (1/8)
const fmtA = (x) => x.toFixed(4);
// Music 220 Hz: volume 0.8 × fades × ducking (level 0.2) under the voice-over 5.0 … 6.5 (now 3.0 … 4.5 after the ripple).
const mFull = amp(220, 1.5, 2.5);
const mDuck = amp(220, 3.3, 4.2);
const mFadeIn = amp(220, 0, 0.3);
check("Music voice-over position after the ripple", "3.0 s (was 5.0 s)", `${project.voices[0].start} s`, Math.abs(project.voices[0].start - 3) < 1e-6);
check("Music level 1.5–2.5 s (volume 0.8, no ducking)", `≈ ${fmtA(0.8 * TONE)}`, fmtA(mFull), Math.abs(mFull - 0.8 * TONE) < 0.02);
check("Music ducked under the voice-over, 3.3–4.2 s", `≈ 0.2 × the full level (${fmtA(0.16 * TONE)})`, `${fmtA(mDuck)} (${(mDuck / mFull).toFixed(2)} ×)`, mDuck / mFull > 0.12 && mDuck / mFull < 0.3);
check("Music fade in, 0–0.3 s (mean gain ≈ 0.12)", `≈ ${fmtA(0.8 * 0.15 * TONE)}`, fmtA(mFadeIn), mFadeIn < 0.35 * mFull);
const mEnd = amp(220, 6.2, 6.5);
check("Music fade out, 6.2–6.5 s", "< 0.35 × full", `${(mEnd / mFull).toFixed(2)} ×`, mEnd < 0.35 * mFull);
// Clip sound mixed with the music.
const a440 = amp(440, 0.4, 1.4);
check("Clip A's own sound (440 Hz) at 50 %, mixed with the music", `≈ ${fmtA(0.5 * TONE)}`, fmtA(a440), Math.abs(a440 - 0.5 * TONE) < 0.02);
const b660 = amp(660, 2.2, 2.9);
check("Clip B's own sound (660 Hz) at 100 %", `≈ ${fmtA(TONE)}`, fmtA(b660), Math.abs(b660 - TONE) < 0.025);
const c880 = amp(880, 5.0, 6.3);
check("Clip C muted (880 Hz)", "≈ 0", fmtA(c880), c880 < 0.01);
const vo = amp(1000, 3.2, 4.3);
const voBefore = amp(1000, 1.0, 2.5);
check("Voice-over (1 kHz) 3.0–4.5 s", `≈ ${fmtA(TONE)} inside, ≈ 0 before`, `${fmtA(vo)} inside, ${fmtA(voBefore)} before`, Math.abs(vo - TONE) < 0.025 && voBefore < 0.01);

if (pageErrors.length) fails.push(...pageErrors.map((e) => `page error: ${e}`));
check("Tajawal (the studio's Arabic font) loaded in the page", "yes", fontReady ? "yes" : "no", fontReady);
const report = {
  when: new Date().toISOString(),
  codecs: "VP9 + Opus (the engine's test codecs; open-source Chromium has no H.264/AAC)",
  renderMs,
  steps: edited.steps,
  ffprobe: { video: { codec: v.codec_name, width: v.width, height: v.height, nb_frames: v.nb_frames, color_space: v.color_space }, audio: a ? { codec: a.codec_name, sample_rate: a.sample_rate, channels: a.channels } : null, duration: Number(probe.format.duration) },
  project,
  preview,
  checks,
  ok: fails.length === 0,
};
writeFileSync(join(outDir, "report.json"), JSON.stringify(report, null, 2));
if (existsSync(work)) rmSync(work, { recursive: true, force: true });
console.log(JSON.stringify({ renderMs, steps: edited.steps, checks: checks.map((c) => `${c.ok ? "ok  " : "FAIL"} ${c.what}: expected ${c.expected}, observed ${c.observed}`) }, null, 2));
if (fails.length) {
  console.error("FAILED:\n- " + fails.join("\n- "));
  process.exit(1);
}
console.log("OK");
