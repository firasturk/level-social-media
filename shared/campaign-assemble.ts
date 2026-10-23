/**
 * Campaign Autopilot (docs/campaign-autopilot.md), the `assemble` step: a Reel's finished shots
 * become an ordinary, editable video-editor project (`VideoProject`, shared/video-project.ts), the
 * same document the editor saves in `video_projects`. Pure: nothing here reads storage, decodes or
 * renders; the server hands in what it read from the `videos` rows and the music library, and the
 * browser renders the saved project later (src/video-editor/headless-render.ts).
 *
 * What the project holds, built with the editor's own builders (newProject, newClip, gapClip,
 * textOverlays, hookFromPost, applyLook, musicSourceFromTrack, nearestBeat, plainGrid,
 * alignCutsToBeats), so the editor opens it with its timeline, text, music and colour intact:
 *  - the shots in order, each a version of the Reel's post (`{ kind: "version", batch, videoId }`,
 *    the editor's own source reference) trimmed to its planned seconds: a generated clip from just
 *    after its first frames (the image-to-video settling), the client's own clip from its middle,
 *    never past the clip's end; a clip shorter than planned is used whole;
 *  - the joins the plan asked for: cuts, crossfades, or mixed (cuts, with crossfades into and out of
 *    photos and into the end card); a crossfade takes half its length from each side of the cut,
 *    so every cut stays on its planned second;
 *  - with a music library track: the track (with its licence and credit), the clips' own sound
 *    muted, and, when the track's BPM is known, its beat grid (from the track's start, an
 *    assumption: the library knows the tempo, not the phase) with every cut moved to the nearest
 *    pulse before the clips are cut, then a roll edit for any cut a short clip moved off it;
 *  - the output size of the Reel's frame, the plan's look (at 80 %), the shot's words over each
 *    shot, the hook over the first, the call to action on the end card (the last shot) with the
 *    brand's logo, in Arabic, English or both;
 *  - an `edit` record that says, in plain lines, what was assembled.
 *
 * Photos: the timeline's footage is H.264 video only (a clip source is a stored version, a file in
 * the tab, or a gap). A shot that uses the client's photo is a gap of its length here, with a slow
 * push in already set; `stillShots` lists those gaps with their picture, and the browser render
 * (`renderProjectToCard` with `stills`) draws each picture as a short clip at the project's size
 * (src/studio/stillClip.ts, as "Combine into one video" does), stores it as a version of the post,
 * puts it in place of its gap, saves the project and renders that revision. Until then the editor
 * shows the photo's shot as an empty stretch of the right length (the summary says so).
 *
 * Deterministic: the same input and `now` give the same document (clip and layer ids are derived
 * from the shot keys and a counter, never random).
 */
import { SHOT_SECONDS, type CampaignLanguage, type VideoPlanItem } from "./campaign-plan";
import { plainGrid } from "./music-bars";
import type { MusicTrack } from "./music";
import { checkOverlays, MAX_OVERLAYS, outputForFrame, type LogoOverlay, type Overlay } from "./video-compose";
import type { FrameId } from "./video-frame";
import { applyLook } from "./video-looks";
import { alignCutsToBeats } from "./video-timeline";
import { hookFromPost, textOverlays, type TemplateText } from "./video-templates";
import { PURPOSE_TEXT } from "./edit-plan";
import {
  cutTimes,
  DEFAULT_DUCKING,
  gapClip,
  LOOKS,
  MAX_TIMELINE_SECONDS,
  MIN_CLIP_SECONDS,
  musicSourceFromTrack,
  nearestBeat,
  newClip,
  newProject,
  placeClips,
  timelineBeats,
  totalLength,
  type Clip,
  type Music,
  type Transition,
  type VideoProject,
} from "./video-project";

/* ───────────── Input ───────────── */

/** On-screen words: one string (Arabic and English lines split by a new line, " / " or " | "), or the two languages apart. */
export type AssembleWords = string | { ar?: string | null; en?: string | null } | null;

/**
 * Where a shot's picture comes from:
 * - `video`: a finished version of the Reel's post (a `videos` row, status done, key in R2): a clip
 *   generated for this shot (`origin: "generated"`) or the client's own clip already stored as a
 *   version (`origin: "existing"`). `duration` is the clip's real length in seconds. `start`
 *   (optional) says where in the clip the shot starts.
 * - `photo`: the client's picture used as it is (`url`: a same-origin address the browser can read).
 */
export type AssembleSource =
  | { kind: "video"; videoId: string; duration: number; origin: "generated" | "existing"; start?: number }
  | { kind: "photo"; url: string; name: string };

export interface AssembleShot {
  /** The plan's shot key ("s1"); the clip's id is derived from it. Defaults to `s<n>`. */
  key?: string;
  /** Planned seconds on the timeline. */
  seconds: number;
  /** On-screen words during this shot ("" or null for none). */
  text: AssembleWords;
  source: AssembleSource;
}

export interface AssembleInput {
  /** The project's name (the Reel's title). */
  name: string;
  /** The month (batch id) the Reel's post and its versions belong to. */
  batch: string;
  shots: AssembleShot[];
  frame: FrameId;
  hook: AssembleWords;
  cta: AssembleWords;
  language: CampaignLanguage;
  transitions: VideoPlanItem["transitions"];
  /** A look id from the editor's looks (shared/video-project.ts LOOKS), "" for none. */
  look: string;
  /** The brand kit's logo: a same-origin address (`/api/...`) or a small data: URL. */
  logo: { src: string; name: string } | null;
  /** A music library track (catalog or the client's library) as the library describes it, null for none. */
  music: MusicTrack | null;
}

/* ───────────── Constants ───────────── */

/** The look's intensity when the plan names one (the person can move it under Colour). */
export const ASSEMBLE_LOOK_AMOUNT = 0.8;
/** A crossfade's length, seconds. */
export const ASSEMBLE_CROSSFADE = 0.4;
/** Where a generated clip's shot starts when the clip is longer than the shot: just after the frames where image-to-video settles. */
export const GENERATED_LEAD = 0.2;
/** The music's level and fades, as the editor sets them when a track is chosen. */
const MUSIC = { volume: 0.9, fadeIn: 0.5, fadeOut: 1 } as const;
/** The end card's call to action stays at least this long (or the whole last shot when shorter). */
const CTA_MIN = 1.2;
/** A photo's slow push in: the zoom it ends on. */
const PHOTO_PUSH = 1.06;

/** Text styles: the hook and the call to action as the auto edit draws them (shared/edit-plan.ts), a shot's words as a lower third on a box. */
const HOOK_STYLE: TemplateText = PURPOSE_TEXT.launch.hook;
const CTA_STYLE: TemplateText = PURPOSE_TEXT.launch.end;
const WORDS_STYLE: TemplateText = { role: "subline", en: "", ar: "", from: 0, to: 0, x: 0.5, y: 0.74, size: 0.05, font: "sans", weight: 800, color: "#ffffff", box: "#000000" };
/** A shot's words lifted above the call to action when both share a short end card. */
const WORDS_HIGH_Y = 0.6;

/** The clip id of a shot: stable, so the server and the browser can find it again (`stillShots`). */
export const shotClipId = (shot: Pick<AssembleShot, "key">, index: number): string => `shot-${(shot.key || `s${index + 1}`).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 30) || index + 1}`;

const round3 = (v: number) => Math.round(v * 1000) / 1000;
const round6 = (v: number) => Math.round(v * 1e6) / 1e6;
const fmt = (s: number) => `${(Math.round(s * 10) / 10).toFixed(1)} s`;
const ARABIC = /[؀-ۿ]/;

/* ───────────── Words ───────────── */

/** The Arabic and the English line of some words, as `hookFromPost` reads a post's headline and second line. */
export function splitWords(w: AssembleWords): { ar: string; en: string } {
  if (!w) return { ar: "", en: "" };
  if (typeof w !== "string") return { ar: (w.ar ?? "").trim(), en: (w.en ?? "").trim() };
  const parts = w
    .split(/\n| \/ | \| /)
    .map((p) => p.trim())
    .filter(Boolean);
  return { ar: parts.filter((p) => ARABIC.test(p)).join(" "), en: parts.filter((p) => !ARABIC.test(p)).join(" ") };
}

/** Text layers for some words in a style, from `start` to `end`: the language asked for, or the one there is. */
function wordLayers(w: AssembleWords, style: TemplateText, start: number, end: number, language: CampaignLanguage, aspect: number, nextId: () => string): Overlay[] {
  const { ar, en } = splitWords(w);
  const own = hookFromPost(style, { headline: ar.slice(0, 300) || null, subline: en.slice(0, 300) || null }, language);
  if (!own || end - start < 0.1) return [];
  return textOverlays(own.tx, start, end, own.language, aspect, nextId);
}

const hasWords = (w: AssembleWords) => {
  const s = splitWords(w);
  return !!(s.ar || s.en);
};

/* ───────────── Joins and timing ───────────── */

function joinsFor(input: AssembleInput, n: number): { transition: Transition; d: number }[] {
  return Array.from({ length: n }, (_, i) => {
    if (i === 0) return { transition: "cut" as const, d: 0.3 };
    const photo = input.shots[i].source.kind === "photo" || input.shots[i - 1].source.kind === "photo";
    const fade = input.transitions === "crossfades" || (input.transitions === "mixed" && (i === n - 1 || photo));
    return fade ? { transition: "crossfade" as const, d: ASSEMBLE_CROSSFADE } : { transition: "cut" as const, d: 0.3 };
  });
}

/** The track's beat grid in track seconds from its BPM (from the track's start), within its length and a little past the cut. */
export function beatsFromBpm(bpm: number | null | undefined, until: number): number[] {
  if (!bpm || !Number.isFinite(bpm) || bpm < 40 || bpm > 240 || !(until > 0)) return [];
  const period = 60 / bpm;
  const out: number[] = [];
  for (let k = 0; k * period <= until + 1e-9 && out.length < 5000; k++) out.push(Math.round(k * period * 1000) / 1000);
  return out;
}

/**
 * The planned cut times (cumulative seconds) moved onto the pulse: each cut to the nearest pulse
 * (within half a pulse, so every cut lands on one), never closer than a second to the cut before
 * (a shot keeps at least a second) and never later than the timeline's limit; the end too.
 */
function snapPlan(bounds: readonly number[], pulse: readonly number[], period: number): number[] {
  if (pulse.length < 2 || !(period > 0)) return [...bounds];
  const out = [0];
  for (let i = 1; i < bounds.length; i++) {
    const min = out[i - 1] + SHOT_SECONDS.min - 1e-6;
    let t = nearestBeat(bounds[i], pulse, period / 2 + 1e-6);
    if (t < min || t > MAX_TIMELINE_SECONDS) {
      // The next pulse after the shortest allowed shot, else the planned time.
      const later = pulse.find((b) => b >= min && b <= MAX_TIMELINE_SECONDS);
      t = later !== undefined && later - bounds[i] <= period ? later : Math.max(min, Math.min(MAX_TIMELINE_SECONDS, bounds[i]));
    }
    out.push(round6(t));
  }
  return out;
}

/* ───────────── The project ───────────── */

/** The shots that use a photo: their clip (a gap until the browser draws the picture as a clip), the picture and its name. */
export function stillShots(input: Pick<AssembleInput, "shots">): StillRef[] {
  return input.shots.flatMap((s, i) => (s.source.kind === "photo" ? [{ clipId: shotClipId(s, i), url: s.source.url, name: s.source.name }] : []));
}

export interface StillRef {
  clipId: string;
  url: string;
  name: string;
}

/** Seconds of picture a photo's clip is drawn with beyond what its gap uses (the encoder rounds to whole frames). */
export const STILL_MARGIN = 0.2;

/**
 * The photo shots of a saved project still to draw: each listed still whose clip is still a gap
 * (one already drawn is a version now, one the person deleted is gone), with the seconds of
 * picture it needs (its out point, plus a margin, at most the editor's limit).
 */
export function pendingStills(project: Pick<VideoProject, "clips">, stills: readonly StillRef[]): { still: StillRef; clipId: string; seconds: number }[] {
  return stills.flatMap((still) => {
    const c = project.clips.find((x) => x.id === still.clipId);
    if (!c || c.source.kind !== "gap") return [];
    return [{ still, clipId: c.id, seconds: Math.min(MAX_TIMELINE_SECONDS, Math.ceil((c.out + STILL_MARGIN) * 10) / 10) }];
  });
}

/**
 * A photo's gap replaced by the clip drawn from the photo (a version of the post): same id, place,
 * length, join, framing and push in; the clip's sound muted like the others when there is music.
 * Unchanged when the clip is not a gap any more.
 */
export function placeStillClip(project: VideoProject, clipId: string, version: { batch: string; videoId: string; duration: number }): VideoProject {
  const i = project.clips.findIndex((c) => c.id === clipId);
  const c = project.clips[i];
  if (!c || c.source.kind !== "gap" || !(version.duration >= MIN_CLIP_SECONDS)) return project;
  const out = round6(Math.min(c.out, version.duration));
  const inn = c.in < out - MIN_CLIP_SECONDS * c.speed ? c.in : 0;
  const clip: Clip = { ...c, source: { kind: "version", batch: version.batch, videoId: version.videoId }, duration: version.duration, in: inn, out, ...(project.music ? { muted: true } : {}) };
  const clips = [...project.clips];
  clips[i] = clip;
  return { ...project, clips };
}

/** A Reel's finished shots, words, logo, look, music and joins as an ordinary editable project; see the file's header. */
export function assembleReel(input: AssembleInput, now = Date.now()): VideoProject {
  if (!input.shots.length) throw new Error("The Reel has no shots to assemble.");
  if (!input.batch) throw new Error("The Reel's month is missing.");
  let counter = 0;
  const nextId = () => String(++counter);
  const notes: string[] = [];
  const shotLines: string[] = [];

  // 1. The planned seconds, held to the plan's range and to the editor's 60 s.
  const planned: number[] = [];
  let acc = 0;
  for (const [i, s] of input.shots.entries()) {
    const want = Math.max(SHOT_SECONDS.min, Math.min(SHOT_SECONDS.max, Number.isFinite(s.seconds) ? s.seconds : SHOT_SECONDS.min));
    const room = MAX_TIMELINE_SECONDS - acc;
    if (room < SHOT_SECONDS.min) {
      notes.push(`Shot ${i + 1}${input.shots.length - i > 1 ? ` and the ${input.shots.length - i - 1} after it` : ""} left out: the editor renders up to ${MAX_TIMELINE_SECONDS} s.`);
      break;
    }
    if (want > room) notes.push(`Shot ${i + 1} shortened to ${fmt(room)} to stay within ${MAX_TIMELINE_SECONDS} s.`);
    planned.push(round6(Math.min(want, room)));
    acc += Math.min(want, room);
  }
  const shots = input.shots.slice(0, planned.length);
  for (const [i, s] of shots.entries()) if (s.source.kind === "video" && !(s.source.duration >= MIN_CLIP_SECONDS)) throw new Error(`Shot ${i + 1}'s clip has no readable length.`);

  // 2. The music and its pulse; the planned cuts moved onto it.
  const track = input.music;
  const plannedTotal = planned.reduce((t, p) => t + p, 0);
  const beats = track ? beatsFromBpm(track.bpm, Math.min(track.duration > 0 ? track.duration : Infinity, MAX_TIMELINE_SECONDS + 5)) : [];
  const grid = beats.length > 1 ? plainGrid(beats) : null;
  const pulse = grid ? timelineBeats({ beats: grid.pulse, offset: 0, start: 0 }, MAX_TIMELINE_SECONDS) : [];
  const bounds = [0];
  for (const p of planned) bounds.push(round6(bounds[bounds.length - 1] + p));
  const cuts = grid && pulse.length > 1 ? snapPlan(bounds, pulse, grid.period) : bounds;
  const lengths = cuts.slice(1).map((t, i) => round6(t - cuts[i]));

  // 3. The clips: each shot's seconds (plus half of each crossfade on its sides) from its source.
  const joins = joinsFor(input, shots.length);
  let clips: Clip[] = shots.map((s, i) => {
    const id = shotClipId(s, i);
    const hIn = joins[i].transition === "crossfade" ? joins[i].d / 2 : 0;
    const hOut = i + 1 < shots.length && joins[i + 1].transition === "crossfade" ? joins[i + 1].d / 2 : 0;
    const need = round6(lengths[i] + hIn + hOut);
    const join = { transition: joins[i].transition, transitionDuration: joins[i].d };
    if (s.source.kind === "photo") {
      shotLines.push(`Shot ${i + 1}: the client's photo “${s.source.name.slice(0, 80)}”, ${fmt(lengths[i])} with a slow push in; it is drawn as a clip in the browser when the Reel is rendered (until then an empty stretch).`);
      return { ...gapClip(need, id), ...join, keyframes: { zoom: [{ t: 0, v: 1, ease: "linear" }, { t: round3(need), v: PHOTO_PUSH, ease: "easeOut" }] } };
    }
    const src = s.source;
    const d = src.duration;
    const len = Math.min(need, d);
    const spare = Math.max(0, d - len);
    const start = src.start !== undefined && Number.isFinite(src.start) ? Math.max(0, Math.min(spare, src.start)) : src.origin === "generated" ? Math.min(GENERATED_LEAD, spare) : spare / 2;
    const what = src.origin === "generated" ? "generated clip" : "the client's clip";
    if (d + 1e-6 < need) shotLines.push(`Shot ${i + 1}: ${what}, ${fmt(d)} long, shorter than the ${fmt(lengths[i])} planned: used whole.`);
    else shotLines.push(`Shot ${i + 1}: ${what}, ${fmt(lengths[i])} from ${fmt(start)} of its ${fmt(d)}.`);
    return { ...newClip({ kind: "version", batch: input.batch, videoId: src.videoId }, d, id), in: round6(start), out: round6(start + len), ...join };
  });

  // A clip shorter than planned moved the cuts after it: roll them back onto the pulse where the footage allows.
  if (grid && pulse.length > 1) clips = alignCutsToBeats(clips, pulse, grid.period / 2 + 1e-6).clips.map((c) => ({ ...c, in: round6(c.in), out: round6(c.out) }));
  // Never past the editor's limit (the last shot gives way).
  while (clips.length && totalLength({ clips }) > MAX_TIMELINE_SECONDS + 1e-6) {
    const last = clips[clips.length - 1];
    const over = totalLength({ clips }) - MAX_TIMELINE_SECONDS;
    if (last.out - over * last.speed > last.in + MIN_CLIP_SECONDS) clips[clips.length - 1] = { ...last, out: round6(last.out - over * last.speed), ...(last.source.kind === "gap" ? { duration: round6(last.out - over * last.speed) } : {}) };
    else clips.pop();
  }

  // 4. The project: frame, clips, music, look.
  let project = newProject(input.name.trim().slice(0, 120) || "Campaign Reel", now);
  project.output = { ...project.output, ...outputForFrame(input.frame) };
  project.clips = clips;
  let musicLine: string;
  if (track) {
    const music: Music = { source: musicSourceFromTrack(track), offset: 0, volume: MUSIC.volume, fadeIn: MUSIC.fadeIn, fadeOut: MUSIC.fadeOut, ...(track.duration > 0 ? { duration: round3(track.duration) } : {}), ...(beats.length ? { beats } : {}), start: 0, duck: { ...DEFAULT_DUCKING } };
    project.music = music;
    project.snapToBeats = beats.length > 1;
    // The Reel's sound is the track: the clips' own sound is muted (unmute a clip under Media).
    project.clips = project.clips.map((c) => (c.source.kind === "gap" ? c : { ...c, muted: true }));
    const placedCuts = cutTimes(project.clips);
    const onBeat = placedCuts.filter((t) => pulse.some((b) => Math.abs(b - t) <= 0.02)).length;
    musicLine = grid
      ? `Music: “${track.title}”, cuts snapped to its beat: ${onBeat} of ${placedCuts.length} on the beat at ${Math.round(grid.bpm)} BPM (the grid is counted from the track's start; Snap to beats is on). The clips' own sound is muted.`
      : `Music: “${track.title}”; its tempo is not known, so the cuts stay on the planned seconds. The clips' own sound is muted.`;
    if (track.licence.attributionRequired) notes.push("The track's licence asks for credit: copy the credit line under Music into the post's caption.");
  } else musicLine = "No music: the clips keep their own sound.";
  const look = input.look && input.look !== "none" ? LOOKS.find((l) => l.id === input.look && !l.legacy) : undefined;
  if (look) project = applyLook(project, { kind: "all" }, look.id, ASSEMBLE_LOOK_AMOUNT);
  else if (input.look && input.look !== "none") notes.push(`The look “${input.look}” is not one of the editor's looks: none applied.`);

  // 5. The words and the logo, on the clips' final times.
  const placed = placeClips(project.clips);
  const end = placed.length ? placed[placed.length - 1].end : 0;
  const cutAt = [0, ...cutTimes(project.clips), end];
  const aspect = project.output.width / Math.max(1, project.output.height);
  const language = input.language;
  const overlays: Overlay[] = [];
  const last = project.clips.length - 1;
  const hasCta = hasWords(input.cta);
  const lastLen = cutAt[last + 1] - cutAt[last];
  const ctaLen = Math.min(lastLen, Math.max(CTA_MIN, lastLen * 0.5));
  const ctaStart = round3(end - ctaLen);
  // The hook over the first shot (and the second when the first is under 1.5 s).
  const hookEnd = cutAt[1] - cutAt[0] < 1.5 && project.clips.length > 2 ? cutAt[2] : cutAt[1];
  overlays.push(...wordLayers(input.hook, HOOK_STYLE, 0.1, round3(hookEnd), language, aspect, nextId));
  let shared = false;
  project.clips.forEach((_, i) => {
    const w = shots[i].text;
    if (!hasWords(w)) return;
    const a = round3(cutAt[i] + (i ? 0.1 : 0.2));
    let b = round3(cutAt[i + 1]);
    let style = WORDS_STYLE;
    if (i === last && hasCta) {
      // The end card: the shot's words first, then the call to action; on a short end card both, the words lifted.
      if (ctaStart - a >= 0.8) b = ctaStart;
      else {
        style = { ...WORDS_STYLE, y: WORDS_HIGH_Y };
        shared = true;
      }
    }
    overlays.push(...wordLayers(w, style, a, b, language, aspect, nextId));
  });
  if (hasCta) overlays.push(...wordLayers(input.cta, CTA_STYLE, ctaStart, round3(end), language, aspect, nextId));
  let logoLine = "No logo in the brand kit: add one under Logo.";
  if (input.logo?.src) {
    const l: LogoOverlay = { id: `o${nextId()}`, kind: "logo", src: input.logo.src, name: (input.logo.name || "Logo").slice(0, 120), start: round3(Math.min(end - 0.2, cutAt[last] + 0.2)), end: round3(end), x: 0.5, y: 0.12, width: 0.26, opacity: 1 };
    if (typeof checkOverlays([l]) === "string") {
      notes.push("The brand kit's logo is not a picture the editor can draw (it must be a studio address or a small file): add it under Logo.");
      logoLine = "Logo: not added (see the note).";
    } else {
      overlays.push(l);
      logoLine = "Logo: the brand kit's, on the end card.";
    }
  }
  if (overlays.length > MAX_OVERLAYS) notes.push(`Only the first ${MAX_OVERLAYS} text and logo layers were kept.`);
  project.overlays = overlays.slice(0, MAX_OVERLAYS);

  // 6. What was assembled, in plain lines.
  const langWord = language === "both" ? "Arabic and English" : language === "ar" ? "Arabic" : "English";
  const joinLine =
    input.transitions === "crossfades" ? `Joins: crossfades (${ASSEMBLE_CROSSFADE} s), each centred on its cut.` : input.transitions === "mixed" ? `Joins: cuts, with crossfades (${ASSEMBLE_CROSSFADE} s) into and out of photos and into the end card.` : "Joins: cuts.";
  const textParts = [hasWords(input.hook) && "the hook over the first shot", shots.some((s) => hasWords(s.text)) && "each shot's words over it", hasCta && `the call to action on the end card${shared ? " (with the last shot's words above it)" : ""}`].filter(Boolean);
  const total = totalLength(project);
  const summary = [
    `Assembled from the campaign plan: ${project.clips.length} shot${project.clips.length === 1 ? "" : "s"}, ${fmt(total)} (planned ${fmt(plannedTotal)}), ${input.frame} at ${project.output.width}×${project.output.height}.`,
    ...shotLines,
    joinLine,
    musicLine,
    textParts.length ? `Text (${langWord}, where the plan has those words): ${textParts.join(", ")}.` : "Text: the plan has no words for this Reel.",
    look ? `Look: ${look.name} at ${Math.round(ASSEMBLE_LOOK_AMOUNT * 100)} %.` : "Look: none.",
    logoLine,
    ...notes,
  ];
  // At most 16 lines: the per-shot lines are folded into one when there are many.
  const lines = summary.length > 16 ? [summary[0], `Shots: ${shotLines.map((l) => l.replace(/^Shot (\d+): /, "$1 ")).join(" · ")}`.slice(0, 400), ...summary.slice(1 + shotLines.length)] : summary;
  project.edit = { purpose: "campaign", pace: input.transitions, summary: lines.slice(0, 16).map((l) => l.slice(0, 400)), at: now };
  project.updatedAt = now;
  return project;
}
