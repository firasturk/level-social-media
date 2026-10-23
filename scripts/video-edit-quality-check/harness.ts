/**
 * The browser half of scripts/video-edit-quality-check.mjs: the editor's real engine (media store,
 * motion energy, the auto edit planners, the compositor and the export) bundled on its own and
 * driven through `window`, on real footage. Nothing here is part of the studio's bundle.
 */
import { MediaStore } from "@/video-editor/engine/media";
import { exportProject } from "@/video-editor/engine/export";
import { beatsOf, decodeAudio } from "@/video-editor/engine/audio";
import { checkCapabilities, STUDIO_CODECS, TEST_CODECS, type ExportCodecs } from "@/video-editor/engine/capabilities";
import { newClipId, newProject, placeClips, timelineBeats, totalLength, validateProject, type Clip, type ClipSource, type VideoProject } from "@shared/video-project";
import { planFirstCut, type FirstCutInput, type Pace, type Purpose } from "@shared/video-autoedit";
import { fillSlots, planEdit, withEditPlan, type PlanSource } from "@shared/edit-plan";
import { analyseReferenceFile, footageAnalysis, timelineGrid } from "@/video-editor/engine/analyse";
import { clipStats } from "@/video-editor/engine/looks";
import { fitTransfer } from "@shared/colour-match";
import { compareTimings, templateFromReference } from "@shared/reference-template";
import { applyTemplate } from "@shared/video-templates";

const media = new MediaStore();
let music: AudioBuffer | null = null;
const names = new Map<string, ClipSource>();

async function addSource(name: string, url: string) {
  const blob = await (await fetch(url)).blob();
  const file = new File([blob], name, { type: "video/mp4" });
  const source: ClipSource = { kind: "upload", name, size: blob.size };
  const m = await media.add(source, { url: URL.createObjectURL(file), file, label: name });
  names.set(name, source);
  return { key: m.key, duration: m.duration, width: m.width, height: m.height };
}

async function loadMusic(url: string) {
  const r = await fetch(url);
  music = await decodeAudio(await r.arrayBuffer());
  if (!music) throw new Error("music not decoded");
  const beats = beatsOf(music);
  return { duration: music.duration, beats };
}

async function codecs() {
  const studio = await checkCapabilities({ width: 1080, height: 1920, fps: 30 }, STUDIO_CODECS);
  const test = await checkCapabilities({ width: 1080, height: 1920, fps: 30 }, TEST_CODECS);
  return { studio, test };
}

/** The panel's "Build the cut" as it is on qa-round (VideoEditor.tsx runAuto), step for step. */
async function baseline(opts: { purpose: Purpose; pace: Pace; target: number; music?: { name: string; beats: number[]; duration: number } | null }) {
  const p0 = { ...newProject("Baseline", 1), output: { width: 1080, height: 1920, fps: 30, bitrate: 6_000_000 } } as VideoProject;
  if (opts.music) p0.music = { source: { kind: "upload", name: opts.music.name, size: 0 }, offset: 0, volume: 0.9, fadeIn: 0.5, fadeOut: 1, duration: opts.music.duration, beats: opts.music.beats, start: 0, duck: { enabled: true, level: 0.3 } };
  const inputs: FirstCutInput[] = [];
  const energies: Record<string, number[]> = {};
  for (const [i, m] of media.all().entries()) {
    const energy = await media.energy(m).catch(() => new Float32Array(0));
    energies[m.label] = Array.from(energy, (v) => Math.round(v * 10000) / 10000);
    inputs.push({ id: `s${i}`, source: m.source, duration: m.duration, energy, step: 0.5 });
  }
  const grid = timelineBeats(p0.music, Math.max(opts.target, totalLength(p0)) + 5);
  const plan = planFirstCut(inputs, { purpose: opts.purpose, pace: opts.pace, target: opts.target, beats: grid.length ? grid : undefined, locked: [] });
  const clips = plan.clips.map((c) => ({ ...c, id: newClipId() }));
  const project: VideoProject = { ...p0, clips, look: p0.look === "none" ? plan.look : p0.look };
  const v = validateProject(project);
  if (!v.ok) throw new Error(v.reason);
  return { project: v.project, notes: plan.notes, energies };
}

/** Each source read for the new auto edit (as VideoEditor's runAuto does), with a summary for the report. */
async function analyseAll() {
  const out: Record<string, unknown> = {};
  for (const m of media.all()) {
    const t0 = performance.now();
    const a = await footageAnalysis(media, m);
    if (!a) {
      out[m.label] = null;
      continue;
    }
    const flags: Record<string, number> = {};
    for (const w of a.windows) for (const f of w.flags) flags[f] = (flags[f] ?? 0) + 1;
    out[m.label] = { ms: Math.round(performance.now() - t0), shots: a.shots, boundaries: a.boundaries, flags, windows: a.windows.map((w) => ({ t: w.t, q: w.quality, a: w.action, luma: w.luma, focus: w.focus, flags: w.flags.join(","), text: w.textY, sharp: w.sharp })) };
  }
  return out;
}

/** The new "Build the cut" (VideoEditor.tsx runAuto), step for step. */
async function after(opts: { purpose: Purpose; pace: Pace; target: number; music?: { name: string; beats: number[]; duration: number } | null; ramps?: boolean; locked?: { clip: Clip; start: number }[]; base?: VideoProject }) {
  const p0 = opts.base ?? ({ ...newProject("After", 1), output: { width: 1080, height: 1920, fps: 30, bitrate: 6_000_000 } } as VideoProject);
  if (opts.music) p0.music = { source: { kind: "upload", name: opts.music.name, size: 0 }, offset: 0, volume: 0.9, fadeIn: 0.5, fadeOut: 1, duration: opts.music.duration, beats: opts.music.beats, start: 0, duck: { enabled: true, level: 0.3 } };
  const sources: PlanSource[] = [];
  for (const [i, m] of media.all().entries()) {
    const analysis = await footageAnalysis(media, m);
    const speech = p0.clips.filter((c) => c.speech && c.source.kind !== "gap" && media.get(c.source)?.key === m.key).map((c) => ({ in: c.in, out: c.out }));
    sources.push({ id: `s${i}`, source: m.source, label: m.label.replace(/\.mp4$/, ""), duration: m.duration, width: m.width, height: m.height, analysis, ...(speech.length ? { speech } : {}) });
  }
  const grid = p0.music ? timelineGrid(p0, Math.max(opts.target, totalLength(p0)) + 5, music) : null;
  const t0 = performance.now();
  const plan = planEdit(sources, { purpose: opts.purpose, pace: opts.pace, target: opts.target, grid, locked: opts.locked ?? [], output: p0.output, ramps: opts.ramps, language: "en" });
  const ms = Math.round(performance.now() - t0);
  const project = withEditPlan(p0, { ...plan, clips: plan.clips.map((c) => (c.locked ? c : { ...c, id: newClipId() })) }, { purpose: opts.purpose, pace: opts.pace, at: 1 });
  const v = validateProject(project);
  if (!v.ok) throw new Error(v.reason);
  return { project: v.project, summary: plan.summary, notes: plan.notes, shots: plan.shots, skipped: plan.skipped, planMs: ms, grid: grid ? { bpm: grid.bpm, bars: grid.bars.slice(0, 12), pulse: grid.pulse.length, confidence: grid.confidence } : null };
}

/** "Edit like this video", as the Auto edit panel does it: the reference read frame by frame, its template filled with the footage, optionally its colour matched. */
async function reference(url: string, name: string, opts: { language?: "en" | "ar" | "both"; matchColour?: boolean } = {}) {
  const t0 = performance.now();
  const bytes = await (await fetch(url)).arrayBuffer();
  const analysis = await analyseReferenceFile(bytes, { kind: "upload", id: name, name });
  const analyseMs = Math.round(performance.now() - t0);
  const sources: PlanSource[] = [];
  for (const [i, m] of media.all().entries()) sources.push({ id: `s${i}`, source: m.source, label: m.label.replace(/\.mp4$/, ""), duration: m.duration, width: m.width, height: m.height, analysis: await footageAnalysis(media, m) });
  const { template, notes } = templateFromReference(analysis);
  const output = analysis.height > analysis.width ? { width: 1080, height: 1920 } : { width: 1920, height: 1080 };
  const fills = fillSlots(sources, template.slots.map((s) => ({ duration: s.duration, action: s.action ?? 0.5 })), output);
  const base = { ...newProject("Like the reference", 1), output: { ...output, fps: 30, bitrate: 6_000_000 } } as VideoProject;
  let project = applyTemplate(template, base, [], { windows: fills, keepLook: true, language: opts.language ?? "en", frame: "keep", now: 1 });
  if (opts.matchColour && analysis.colour) {
    const ref = { n: 1, mean: analysis.colour.mean, std: analysis.colour.std, sum: analysis.colour.mean, sumSq: [0, 0, 0] as [number, number, number] };
    const clips = [];
    for (const c of project.clips) {
      const m = media.get(c.source);
      if (!m) {
        clips.push(c);
        continue;
      }
      const { stats, frames } = await clipStats(m.url, c, 5);
      const t = fitTransfer(stats, ref);
      clips.push({ ...c, match: { ref: { kind: "video" as const, id: name, name }, scale: t.scale, offset: t.offset, amount: 0.8, frames, at: 1 } });
    }
    project = { ...project, clips };
  }
  project = { ...project, reference: { analysis, appliedAt: 1, matchColour: !!opts.matchColour } };
  // Saved and read back, as a reopen does.
  const v = validateProject(JSON.parse(JSON.stringify(project)));
  if (!v.ok) throw new Error(v.reason);
  const rows = compareTimings(analysis, v.project.clips, (c) => (c.source.kind === "upload" ? c.source.name.replace(/\.mp4$/, "") : c.source.kind));
  return { analysis, analyseMs, template: { slots: template.slots.map((s) => ({ d: s.duration, push: s.push ?? null, action: s.action })), texts: template.texts.map((t) => ({ from: t.from, to: t.to, y: t.y })), notes }, fills: fills.map((f) => (f ? { label: f.label, in: f.in, out: f.out, action: f.action, quality: f.quality } : null)), project: v.project, rows, json: JSON.stringify(v.project.reference).length };
}

function b64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

async function render(project: VideoProject, which: "test" | "studio" | "h264-opus" = "test") {
  const t0 = performance.now();
  const c: ExportCodecs = which === "studio" ? STUDIO_CODECS : which === "h264-opus" ? { video: "avc", audio: "opus" } : TEST_CODECS;
  const r = await exportProject({ project, media, music, lut: null, codecs: c, onProgress: () => undefined });
  const mp4 = b64(new Uint8Array(await r.blob.arrayBuffer()));
  return { width: r.width, height: r.height, duration: r.duration, frames: r.frames, codec: r.videoCodec, mp4, ms: Math.round(performance.now() - t0) };
}

const placed = (p: VideoProject) => placeClips(p.clips).map((x) => ({ start: x.start, end: x.end, overlap: x.overlap, label: x.clip.source.kind === "upload" ? x.clip.source.name : x.clip.source.kind, in: x.clip.in, out: x.clip.out, speed: x.clip.speed, transition: x.clip.transition, framing: x.clip.framing ?? null }));

Object.assign(window, { harness: { addSource, loadMusic, codecs, baseline, analyseAll, after, reference, render, placed } });
document.title = "ready";
