/**
 * Edit quality, checked on real footage (docs/video-editor.md → Edit quality): the editor's engine
 * (scripts/video-edit-quality-check/harness.ts, bundled with Vite) runs in a real Google Chrome on
 * the footage given with --footage (H.264 MP4s), builds cuts and renders them, then inspects the
 * files with ffprobe and ffmpeg and draws frame strips:
 *   --part baseline    the auto edit as it was on qa-round (planFirstCut on motion energy)
 *   --part after       the new auto edit (shot quality, structure, bars) on the same footage
 *   --part reference   "Edit like this video": a reference cut with ffmpeg from the footage with a
 *                      known rhythm, analysed in the browser, its template applied, compared
 * Chrome has H.264 decode and encode but no AAC encoder, so renders are H.264 + Opus in MP4 (the
 * studio's own path renders AAC; nothing else differs).
 *
 * Usage: node scripts/video-edit-quality-check.mjs --footage <dir> --out <dir> --chrome <path> [--part baseline,after,reference]
 */
import { createServer } from "node:http";
import { execFileSync, execSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const arg = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const outDir = arg("--out", join(root, "smoke", "edit-quality"));
const footage = arg("--footage", null);
const chromePath = arg("--chrome", process.env.CHROME_PATH || "/opt/pw-browsers/chromium");
const parts = new Set(arg("--part", "baseline,after,reference").split(","));
if (!footage) throw new Error("--footage <dir of H.264 mp4 clips> is required");
mkdirSync(outDir, { recursive: true });
const work = mkdtempSync(join(tmpdir(), "edit-quality-"));
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
const probe = (file) => JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", file], { encoding: "utf8" }));

/* ───────────── The harness and the test music ───────────── */
const harnessOut = join(work, "harness");
const alias = { "@": join(root, "src"), "@shared": join(root, "shared") };
await build({ configFile: false, logLevel: "warn", root: join(root, "scripts", "video-edit-quality-check"), resolve: { alias }, build: { outDir: harnessOut, emptyOutDir: true, minify: false } });
const entry = join(work, "music-entry.ts");
writeFileSync(entry, `export { synthTestWav } from ${JSON.stringify(join(root, "shared", "music-test-audio.ts"))};\nexport { catalogEntry } from ${JSON.stringify(join(root, "shared", "music-catalog.ts"))};\n`);
await build({ configFile: false, logLevel: "warn", resolve: { alias }, build: { ssr: entry, outDir: join(work, "node"), emptyOutDir: true, minify: false, rollupOptions: { output: { format: "es", entryFileNames: "music.mjs" } } } });
const { synthTestWav, catalogEntry } = await import(pathToFileURL(join(work, "node", "music.mjs")).href);
writeFileSync(join(fx, "music.wav"), Buffer.from(synthTestWav(catalogEntry("test-beat-120").synth)));

const clips = readdirSync(footage).filter((f) => f.endsWith(".mp4")).sort();
const MIME = { ".html": "text/html", ".js": "text/javascript", ".mp4": "video/mp4", ".png": "image/png", ".wav": "audio/wav" };
const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
  const file = path.startsWith("/footage/") ? join(footage, path.slice(9)) : path.startsWith("/fx/") ? join(fx, path.slice(4)) : join(harnessOut, path === "/" ? "index.html" : path);
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

const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ executablePath: chromePath, headless: true, args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"] });
const page = await browser.newPage({ viewport: { width: 900, height: 900 } });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));
page.on("console", (m) => m.type() === "error" && pageErrors.push(m.text()));
page.setDefaultTimeout(15 * 60 * 1000);
await page.goto(url);
await page.waitForFunction(() => document.title === "ready", null, { timeout: 60000 });
const H = (fn, ...a) => page.evaluate(([f, x]) => window.harness[f](...x), [fn, a]);

const report = { generated: new Date().toISOString(), chrome: chromePath, footage: clips, codecs: await H("codecs"), runs: {}, checks: [] };
const fails = [];
const check = (what, expected, observed, ok) => {
  report.checks.push({ what, expected, observed, ok });
  console.log(`${ok ? "ok  " : "FAIL"} ${what}: expected ${expected}, observed ${observed}`);
  if (!ok) fails.push(what);
};
const codec = report.codecs.studio.videoCodec ? "h264-opus" : "test";
console.log(`Chrome: H.264 encoder ${report.codecs.studio.videoCodec ?? "none"}; ${report.codecs.studio.details.join(" ")}`);
report.renderCodecs = codec === "h264-opus" ? "H.264 + Opus in MP4 (Chrome has no AAC encoder)" : "VP9 + Opus in MP4";
report.sources = {};
for (const f of clips) report.sources[f] = await H("addSource", f, `/footage/${f}`);
const music = await H("loadMusic", "/fx/music.wav");
report.music = { name: "Test beat 120 (generated in the studio, CC0)", duration: music.duration, beats: music.beats.length };

/** A render written to disk, probed, with a frame every half second and one strip row per shot (first, middle, last frame). */
async function renderAndStrip(name, project) {
  const r = await H("render", project, codec);
  const file = join(outDir, `${name}.mp4`);
  writeFileSync(file, Buffer.from(r.mp4, "base64"));
  const p = probe(file);
  const v = p.streams.find((s) => s.codec_type === "video");
  const a = p.streams.find((s) => s.codec_type === "audio");
  const placed = await H("placed", project);
  const fps = 30;
  // Every half second, labelled with the time.
  ff("-i", file, "-vf", "fps=2,scale=160:-2,drawtext=text='%{pts\\:hms}':x=3:y=3:fontsize=12:fontcolor=yellow:box=1:boxcolor=black@0.6,tile=10x4:padding=2", "-frames:v", "1", join(outDir, `${name}-every-half-second.jpg`));
  // One row per shot: its first, middle and last frame.
  const frames = [];
  for (const s of placed) {
    const a0 = Math.round(s.start * fps) + (s.overlap ? Math.round(s.overlap * fps) : 0);
    const a1 = Math.max(a0, Math.round(s.end * fps) - 1);
    frames.push(a0, Math.round((a0 + a1) / 2), a1);
  }
  const sel = frames.map((n) => `eq(n\\,${n})`).join("+");
  ff("-i", file, "-vf", `select='${sel}',scale=200:-2,drawtext=text='%{pts\\:hms}':x=3:y=3:fontsize=13:fontcolor=yellow:box=1:boxcolor=black@0.6,tile=3x${placed.length}:padding=3`, "-vsync", "vfr", "-frames:v", "1", join(outDir, `${name}-shots.jpg`));
  return { ms: r.ms, codec: r.codec, engine: { width: r.width, height: r.height, frames: r.frames, duration: r.duration }, ffprobe: { codec: v?.codec_name, width: v?.width, height: v?.height, frames: Number(v?.nb_frames ?? 0), audio: a ? `${a.codec_name} ${a.sample_rate} Hz ${a.channels} ch` : null, duration: Number(p.format.duration) }, shots: placed };
}

/* ───────────── Part 1: the auto edit as it was ───────────── */
if (parts.has("baseline")) {
  for (const [name, opts] of [
    ["baseline-promo-balanced-15s", { purpose: "promo", pace: "balanced", target: 15, music: null }],
    ["baseline-launch-energetic-15s-music", { purpose: "launch", pace: "energetic", target: 15, music: { name: "music.wav", beats: music.beats, duration: music.duration } }],
  ]) {
    const b = await H("baseline", opts);
    const r = await renderAndStrip(name, b.project);
    report.runs[name] = { opts: { ...opts, music: opts.music ? "test beat 120" : null }, notes: b.notes, look: b.project.look, energies: b.energies, ...r };
    check(`${name}: encoded 1080×1920`, "1080×1920", `${r.ffprobe.width}×${r.ffprobe.height}`, r.ffprobe.width === 1080 && r.ffprobe.height === 1920);
    console.log(`${name}: ${r.shots.length} shots, ${r.ffprobe.duration.toFixed(2)} s, ${r.ms} ms`);
  }
}

/* ───────────── The footage as the new auto edit reads it ───────────── */
if (parts.has("analyse") || parts.has("after")) {
  const t0 = Date.now();
  report.analysis = await H("analyseAll");
  report.analysisMs = Date.now() - t0;
  for (const [name, a] of Object.entries(report.analysis)) {
    if (!a) continue;
    const bad = a.windows.filter((w) => w.flags).map((w) => `${w.t.toFixed(1)}:${w.flags}`);
    console.log(`${name}: ${a.ms} ms, own shots ${a.shots.map((s) => `${s.start.toFixed(2)}–${s.end.toFixed(2)}`).join(" | ")}; flagged ${bad.join(" ")}`);
  }
}

/* ───────────── Part 2: the new auto edit on the same footage ───────────── */
if (parts.has("after")) {
  for (const [name, opts] of [
    ["after-promo-balanced-15s", { purpose: "promo", pace: "balanced", target: 15, music: null }],
    ["after-launch-energetic-15s-music", { purpose: "launch", pace: "energetic", target: 15, music: { name: "music.wav", beats: music.beats, duration: music.duration } }],
  ]) {
    const a = await H("after", opts);
    console.log(`${name}:\n  ${a.summary.join("\n  ")}`);
    if (a.notes.length) console.log(`  notes: ${a.notes.join(" ")}`);
    if (args.includes("--plan-only")) {
      console.log(a.shots.map((s) => `  ${s.role.padEnd(6)} ${s.label.padEnd(18)} at ${s.at.toFixed(2)} ${s.length.toFixed(2)} s [${s.in.toFixed(2)}–${s.out.toFixed(2)}] q ${s.quality} a ${s.action}${s.punchIn ? " punch" : ""}`).join("\n"));
      continue;
    }
    const r = await renderAndStrip(name, a.project);
    report.runs[name] = { opts: { ...opts, music: opts.music ? "test beat 120" : null }, summary: a.summary, notes: a.notes, plan: a.shots, skipped: a.skipped, grid: a.grid, planMs: a.planMs, look: a.project.look, overlays: a.project.overlays.map((o) => (o.kind === "text" ? o.text : o.name)), ...r };
    check(`${name}: encoded 1080×1920`, "1080×1920", `${r.ffprobe.width}×${r.ffprobe.height}`, r.ffprobe.width === 1080 && r.ffprobe.height === 1920);
    check(`${name}: length`, `${opts.target} s ±1 pulse`, `${r.ffprobe.duration.toFixed(2)} s`, Math.abs(r.ffprobe.duration - opts.target) < 0.6);
    // No shot crosses a cut or fade of its footage.
    const crossing = a.shots.filter((s) => {
      const an = report.analysis[`${s.label}.mp4`];
      return an && an.boundaries.some((b) => (b.kind === "cut" ? b.t > s.in + 0.02 && b.t < s.out - 0.02 : (b.from ?? b.t) < s.out && (b.to ?? b.t) > s.in));
    });
    check(`${name}: no shot crosses a cut or fade inside its footage`, "0", `${crossing.length}`, crossing.length === 0);
    console.log(`${name}: ${r.shots.length} shots, ${r.ffprobe.duration.toFixed(2)} s, ${r.ms} ms`);
  }
}

/* ───────────── Part 3: "Edit like this video" on a reference with a known rhythm ───────────── */
if (parts.has("reference")) {
  const tos = arg("--tos", join(footage, "..", "src", "tos_720p.mov"));
  // Twelve shots of Tears of Steel (CC BY, Blender Foundation), 0.6 s / 1.2 s alternating (on the beat of a 100 BPM track),
  // cropped to 9:16; the third pushes in; words on the second and fifth.
  const starts = [26, 46, 57.5, 65, 70.5, 75, 86, 104, 121, 154, 160, 174];
  const lens = starts.map((_, i) => (i % 2 ? 1.2 : 0.6));
  const truth = lens.map((_, i) => lens.slice(0, i).reduce((s, x) => s + x, 0));
  const refFile = join(fx, "reference.mp4");
  const inputs = starts.flatMap((s, i) => ["-ss", String(s), "-t", String(lens[i]), "-i", tos]);
  writeFileSync(join(fx, "ref-music.wav"), Buffer.from(synthTestWav({ bpm: 100, seconds: 11, scale: [0, 2, 4, 7, 9, 12], root: 196, pattern: "KHSHKHSH", melody: 0.5, pad: true, seed: 100 })));
  const chains = starts.map((_, i) => {
    let c = `[${i}:v]crop=ih*9/16:ih,scale=720:1280,setsar=1,fps=30`;
    if (i === 2) c += `,zoompan=z='1+0.006*on':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=720x1280:fps=30`;
    if (i === 1 || i === 4) c += `,drawtext=text='NEW DROP':fontsize=72:fontcolor=white:box=1:boxcolor=black@0.7:boxborderw=18:x=(w-tw)/2:y=h*0.74`;
    return `${c},trim=end_frame=${Math.round(lens[i] * 30)},setpts=PTS-STARTPTS[v${i}]`;
  });
  ff(...inputs, "-i", join(fx, "ref-music.wav"), "-filter_complex", `${chains.join(";")};${starts.map((_, i) => `[v${i}]`).join("")}concat=n=${starts.length}:v=1:a=0[v]`, "-map", "[v]", "-map", `${starts.length}:a`, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", "-c:a", "aac", "-b:a", "128k", "-shortest", "-movflags", "+faststart", refFile);
  ff("-i", refFile, "-vf", "fps=10,scale=90:-2,tile=12x9:padding=2", "-frames:v", "1", join(outDir, "reference-every-tenth.jpg"));
  const rp = probe(refFile);
  report.reference = { file: "reference.mp4 (made here from tos_720p.mov)", duration: Number(rp.format.duration), frames: Number(rp.streams.find((s) => s.codec_type === "video").nb_frames), truth: truth.map((t) => Math.round(t * 1000) / 1000), lens };
  const r = await H("reference", "/fx/reference.mp4", "reference.mp4", { language: "en", matchColour: true });
  const shots = r.analysis.shots;
  const err = truth.map((t, i) => (shots[i] ? Math.round((shots[i].start - t) * 30) : null));
  report.reference.analysis = { shots: shots.map((s) => ({ start: s.start, end: s.end, len: Math.round((s.end - s.start) * 1000) / 1000, camera: s.camera, action: s.action, textY: s.textY })), pace: r.analysis.pace, music: r.analysis.music ? { bpm: r.analysis.music.bpm, pulse: r.analysis.music.pulse.length, bars: r.analysis.music.bars.slice(0, 6) } : null, colour: r.analysis.colour, text: r.analysis.text, ms: r.analyseMs, storedChars: r.json };
  report.reference.errorFrames = err;
  report.reference.template = r.template;
  report.reference.fills = r.fills;
  report.reference.rows = r.rows;
  Object.defineProperty(report.reference, "run", { value: r, enumerable: false });
  console.log(`reference: ${shots.length} shots found (truth ${truth.length}); start error in frames: ${err.join(", ")}; ${r.analyseMs} ms`);
  console.log(`  cameras: ${shots.map((s) => s.camera).join(", ")}; text on shots: ${shots.map((s, i) => (s.textY !== null ? `${i + 1}@${s.textY}` : null)).filter(Boolean).join(" ")}; music: ${r.analysis.music ? `${r.analysis.music.bpm} BPM` : "none"}`);
  check("Reference: every shot found", `${truth.length}`, `${shots.length}`, shots.length === truth.length);
  check("Reference: shot starts vs ground truth", "within 1 frame", `max ${Math.max(...err.map((e) => Math.abs(e ?? 99)))} frames`, err.every((e) => e !== null && Math.abs(e) <= 1));
  check("Reference: the push in read as one", "shot 3 push", shots[2]?.camera ?? "-", shots[2]?.camera === "push");
  check("Reference: its tempo", "100 BPM", r.analysis.music ? `${r.analysis.music.bpm} BPM` : "none", !!r.analysis.music && Math.abs(r.analysis.music.bpm - 100) < 3);
  const ours = r.rows.map((x) => x.deltaFrames);
  check("Our cut vs the reference, shot by shot", "within 1 frame", `max ${Math.max(...ours.map((d) => Math.abs(d ?? 99)))} frames`, ours.every((d) => d !== null && Math.abs(d) <= 1));
  if (args.includes("--plan-only")) parts.delete("reference");
}
if (parts.has("reference")) {
  const r = report.reference.run;
  const { truth, lens } = report.reference;
  const refFile = join(fx, "reference.mp4");
  const rr = await renderAndStrip("reference-applied", r.project);
  report.runs["reference-applied"] = { ...rr, overlays: r.project.overlays.map((o) => (o.kind === "text" ? `${o.text} ${o.start}-${o.end} y ${o.y}` : o.name)), matches: r.project.clips.filter((c) => c.match).length };
  // The rendered cut's own cuts, found by ffmpeg, against the reference's.
  const found = [...execFileSync("sh", ["-c", `ffmpeg -v info -i '${join(outDir, "reference-applied.mp4")}' -vf "select='gt(scene,0.2)',showinfo" -f null - 2>&1 || true`], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).matchAll(/pts_time:([0-9.]+)/g)].map((m) => Number(m[1]));
  report.reference.renderedCuts = found;
  const matched = truth.slice(1).map((t) => {
    const n = found.reduce((b, x) => (Math.abs(x - t) < Math.abs(b - t) ? x : b), Infinity);
    return Math.round((n - t) * 30);
  });
  report.reference.renderedErrorFrames = matched;
  console.log(`  rendered cut: cuts found by ffmpeg ${found.map((x) => x.toFixed(2)).join(" ")}; vs reference (frames): ${matched.join(", ")}`);
  check("Rendered cut: its cuts where the reference's are (ffmpeg scene detection)", "within 1 frame", `max ${Math.max(...matched.map(Math.abs))} frames`, matched.every((d) => Math.abs(d) <= 1));
  // A side-by-side strip: reference frame and our frame at the middle of each shot.
  const mids = truth.map((t, i) => t + lens[i] / 2);
  const sel = mids.map((t) => `eq(n\\,${Math.round(t * 30)})`).join("+");
  ff("-i", refFile, "-vf", `select='${sel}',scale=120:-2,tile=12x1:padding=2`, "-vsync", "vfr", "-frames:v", "1", join(outDir, "reference-shots.jpg"));
  ff("-i", join(outDir, "reference-applied.mp4"), "-vf", `select='${sel}',scale=120:-2,tile=12x1:padding=2`, "-vsync", "vfr", "-frames:v", "1", join(outDir, "reference-applied-shots.jpg"));
  ff("-i", join(outDir, "reference-shots.jpg"), "-i", join(outDir, "reference-applied-shots.jpg"), "-filter_complex", "vstack=2", join(outDir, "reference-vs-ours.jpg"));
  if (!existsSync(join(outDir, "reference.mp4"))) writeFileSync(join(outDir, "reference.mp4"), readFileSync(refFile));
}

writeFileSync(join(outDir, "report.json"), JSON.stringify(report, null, 2));
await browser.close();
server.close();
if (pageErrors.length) console.log("page errors:", pageErrors.slice(0, 10));
console.log(fails.length ? `FAILED: ${fails.length}` : "OK");
process.exit(fails.length ? 1 : 0);
