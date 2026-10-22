# The video editor

A post's finished clips (Higgsfield versions, uploaded samples, the person's own footage) cut,
coloured and scored in the browser, exported as an H.264 + AAC mp4 and stored as a new version of
the same post. Nothing new on the client page: an export is a version like any other, shown to the
client only when the person picks it with "Select for client review".

## Architecture

**Where rendering happens.** A Cloudflare Worker cannot decode, render or mux video: there is no
ffmpeg, no native codecs, a CPU-time limit per request and a memory limit well under one clip.
A server render elsewhere (a VM, a render service) is not part of this product. So the browser
renders, with the codecs the person's machine already has.

**The choice: WebCodecs + pure-JS demux/mux.** Three ways were weighed:

| Way | What it needs | Verdict |
| - | - | - |
| **WebCodecs** (`VideoDecoder`, `VideoEncoder`, `AudioEncoder`) with `mp4box.js` to read the mp4 and `mp4-muxer` to write it | A browser with hardware H.264/AAC: Chrome, Edge (all platforms), Safari 16.4+ on Mac and iPhone | **Chosen.** Real-time or faster on a laptop, ~160 KB of JavaScript, no special headers, the exact codecs the output needs |
| `ffmpeg.wasm` | A 30 MB download per session, `SharedArrayBuffer` (so COOP/COEP headers on the studio and every embedded resource), software x264 at well under real time, no GPU | Rejected: too slow and too heavy for a 60 s reel, and the headers would break the share pages and signed links |
| A server render | A machine with ffmpeg | Not available |

The two packages, pinned exactly:

- `mp4box` 2.4.1 (BSD-3-Clause, GPAC; the TypeScript rewrite, ~90 KB minified): reads the file's
  boxes, hands out the H.264 samples with their timestamps and the `avcC` record the decoder needs.
- `mp4-muxer` 5.2.2 (MIT, Vanilacode; ~70 KB): writes the mp4 with `fastStart: "in-memory"`, so
  `moov` sits before `mdat` and iPhone plays from the first byte.

Both are published, widely used, and do one thing each; no other new dependency.

**Browser support.** H.264 decode and encode through WebCodecs: Chrome and Edge on Windows, Mac,
Linux (hardware where present, software otherwise), Safari 16.4+ on Mac and iPhone (hardware).
AAC encode: the same. Open-source Chromium builds (the Playwright one here included) carry **no
H.264 and no AAC** at all; Firefox has no `VideoEncoder` for H.264. The editor asks up front
(`VideoEncoder.isConfigSupported` for `avc1.64002A` / `avc1.640028`, `AudioEncoder` for
`mp4a.40.2`, `VideoDecoder` for H.264) and, when anything is missing, shows "This browser cannot
make an H.264 + AAC video. Use Chrome, Edge or Safari on a computer." and stops. There is no
fallback to VP9/Opus or WebM: iPhone and Instagram need H.264 + AAC, so a file in another codec
would be a file nobody can use.

**What the iPhone needs**, and what the output gives: H.264 High profile level 4.0/4.2 in an MP4
with `moov` in front (faststart), AAC-LC stereo at 48 kHz and 128 kbit/s, 1080×1920, 1080×1080 or
1080×1350 at 30 fps, 4–12 Mbit/s. The studio's upload checks (`server/mp4.ts`) read the stored
file's boxes and record `codecs`, `faststart`, `width`, `height` on the version, so a bad export
would show its warnings in the Video dialog.

**Colour per frame.** A JavaScript loop over 1080×1920 pixels costs 20–40 ms per frame; 1,800
frames would add a minute. The colour tools are one WebGL2 fragment shader instead (exposure,
temperature/tint, contrast, saturation, highlights/shadows, then the 3D LUT from a 3D texture):
under a millisecond per frame on an integrated GPU, and the same shader draws the preview and the
export, so what is seen is what is written.

**Realistic limits.** Clips are read whole into memory (the upload route caps them at 60 MB);
timelines up to 60 s at 30 fps, 1080p; up to 24 clips. A 60 s reel is 1,800 frames: about real
time on a recent laptop with a hardware encoder, 2–4× longer on a phone, which also has less
memory. Beyond 60 s `validateProject` refuses the save and the export says why. Two decoders are
open at most (a crossfade), the others are closed as the timeline moves on.

**Data model.** One JSON document per project (`shared/video-project.ts`, plain TypeScript with a
hand-written `validateProject`; no zod so the browser bundle stays small): `clips[]` with a source
(`{kind:"version", batch, videoId}` or `{kind:"upload", name, size}`), `in`/`out` in source
seconds, `speed`, `transition` (`cut` | `crossfade`) and its length, an optional per-clip colour;
the project's `look` (a named parameter set), `colour`, `lut` (name, size, strength; the table
itself stays in the tab), `music` (an upload or an `audioKey` reserved for the audio library,
`offset`, `volume`, fades, the detected `beats`), `output` (width, height, fps, bitrate),
`snapToBeats`, `rev`, `createdAt`, `updatedAt`. Stored in `video_projects` (migration 0072) with
`source_video` (the version it opened from) and `rendered_video` (the version the last export
made).

**The render pipeline**, step by step (`src/video-editor/engine/export.ts`):

1. Capability check; stop with the message when H.264 or AAC is missing.
2. Each clip's bytes (the Range route for a version, the File for an upload) demuxed once with
   mp4box; its sound decoded with `decodeAudioData` when no music is set.
3. The sound rendered in an `OfflineAudioContext` (music with its offset, volume and fades, or
   the clips' own sound trimmed, sped and crossfaded like the pictures), then encoded with
   `AudioEncoder` into the muxer.
4. For each output frame time t: `frameAt` (shared) says which clip is on screen, at which source
   time, and the mix during a crossfade; a `FrameCursor` per clip hands out the decoded
   `VideoFrame` at that source time (sequential decode; reopened at the key frame before t only
   when going backwards); the grader draws one or two frames with the colour and LUT; a
   `VideoFrame` of the canvas goes to `VideoEncoder` (key frame every two seconds); the muxer
   takes the chunk.
5. Flush, `finalize()`, a Blob; then `POST /render` stores it as a version (or, with no post, the
   file is saved).

**What is not possible**, and is said so in the UI: no server-side render; no Instagram music
library (a track comes from the person's computer, and they must hold its rights); no cheaper
codec path when the browser lacks H.264/AAC; no editing of the words baked into a clip (that is
the Text Studio's job, before the clip is made); a saved project keeps the music's and the LUT's
names, not their files, so they are picked again when a project is reopened for an export.

## What is implemented

- `shared/video-project.ts`: the document, `validateProject`, the timeline arithmetic (`placeClips`,
  `totalLength`, `frameAt`, `splitClip`, `trimClip`, `moveClip`, `cutTimes`), the beat tools
  (`detectBeats`, `nearestBeat`, `snapCutsToBeats`, `timelineBeats`), the auto-edit planner
  (`planAutoEdit`, `bestWindow`), the output presets and size estimate. `shared/cube-lut.ts`: the
  `.cube` reader and a trilinear sampler.
- `server/video-editor.ts` under `/api/studio/posts/video/editor`: `GET /projects`,
  `GET /projects/:id` (every signed-in user under the month's permissions, with `access`),
  `POST /projects`, `PUT /projects/:id` (admins, switch, ledger `editor.save`, estimate 0; a stale
  `rev` answers 409 `{rev, stale: true}`), `POST /render` (admins, switch, ledger `editor.render`;
  the file goes through `storeVideoFile`, the same checks as `/upload`, and becomes a `done`
  version with `provider = 'editor'`, `source = 'editor'`, `model = editor:<project id>`,
  settings `{project, rev, codecs, faststart, …}`; the project's `rendered_video` points at it).
  `storeVideoFile` was factored out of the upload route in `server/video.ts`; the route's behaviour
  is unchanged. Raw footage goes through `/upload` as before and is listed as a version.
- The provider is the existing `editor` switch (`PROVIDER_LABELS.editor = "Video editor"`); its
  description now says what it gates. Members get 403 "Admins only for now: Video editor …".
- `src/video-editor/engine/`: `capabilities.ts`, `demux.ts` (mp4box + `FrameCursor`),
  `grader.ts` (the WebGL2 shader, LUT as a 3D texture), `audio.ts` (decode, energy envelope, beat
  grid, offline mix, AAC encode, the preview's music), `energy.ts` (frame-difference motion
  energy through a hidden `<video>`), `media.ts` (one record per source), `preview.ts` (the
  player: hidden `<video>` elements kept at the source time, drawn through the grader),
  `export.ts` (the pipeline above).
- `src/video-editor/ui/`: `VideoEditor.tsx` (the full-screen editor in the Text Studio's shell:
  preview, transport, timeline, five panels, top bar with undo/redo, Save project, Export, Close;
  one panel at a time with a bottom toolbar under 860 px), `Timeline.tsx` (clip blocks, trim
  handles as one undo step per drag, beat ticks, playhead), `Panels.tsx` (Clips, Auto edit, Music,
  Colour, Export), `history.ts` (undo/redo with mark/patch/commit). Keys: space, ⌘Z/⇧⌘Z, ⌘S, S
  (split), Delete, ←/→ (a frame, ⇧ a second), Esc.
- Entry points: the clapperboard directly under the T on the Studio card (classic and compact
  cards; shown only when the post has a finished version; opens on the client's version, else the
  newest finished clip; the badge refreshes when an export lands); "Edit in the Video editor" per
  finished version in the Video dialog and in the editor's Versions group; `/video-editor` (the
  Sidebar's "Video editor") as a standalone screen with uploads only and a file download.
- Members: the icon shows, the editor opens read-only (preview and timeline; the panels' controls
  are disabled; "Admins only for now" in the top bar and the Export panel).

### Auto edit (heuristics, not AI)

Given the loaded footage, a target length and a style: each clip's motion energy is read every
0.5 s (mean absolute difference of 48×48 grey frames); the target is shared among the clips with a
floor and a ceiling per style (calm 2–6 s shots, energetic 0.8–2.5 s); each shot is the window of
that length with the highest mean energy (later rounds take the next-best, non-overlapping window);
calm keeps the order and joins with 0.5 s crossfades, energetic sorts by energy and hard-cuts; with
music, shot lengths are rounded to whole beats; footage shorter than the target is reused. A shot
shorter than the style's minimum is never added, so the cut can end a little short of the target.
A look is applied when none was chosen (calm → Clean, energetic → Punch). The person edits
everything afterwards; undo restores the previous timeline.

### Music sync

The track's RMS envelope (20 ms hops) feeds `detectBeats`: an onset is a hop above 1.3× the mean of
the second before it, at least 0.25 s after the last; the most common onset spacing (to 20 ms)
becomes the grid period and a grid is laid from the first onset, drifting to the nearest onset
where one exists so quiet bars still get a tick. Limits: it finds pulses, not downbeats or bars;
rubato, very quiet or very dense tracks give a rough grid. The beats show as ticks on the ruler;
"Snap cuts to beats" moves each cut to the nearest beat within 0.25 s by trimming the clip that
ends there (its out point; speed honoured), and stays on so the auto edit cuts on the grid too.

## What is verified, and how

- `tests/video-project.test.ts` (shared, no browser): validation (good and bad documents), clip
  lengths with speed, crossfade overlap and its bounds, `frameAt` mixes, split/trim/move, size
  estimate, beat snapping (tolerance, speed), the beat detector on a synthetic pulse with a missing
  beat, the auto-edit planner on fake energy curves (window choice, calm order and crossfades,
  energetic ordering and beat rounding, reuse of short footage, determinism), the `.cube` reader
  (identity, inverted, domain range, 1D refused, wrong counts).
- `tests/video-editor.test.ts` (server, against the in-memory D1/R2 with every migration applied
  and the paid-route guard asserting zero network calls): member 403 on save, update and render
  with nothing written; member list and open with `access`; admin create → row + ledger row
  (`editor.save`, estimate 0); bad document 400 with a plain reason; `rev` bumps and a stale save
  409 with the current rev; render stores a `done` version with `provider = 'editor'`, the
  project's id and rev in its settings, links `rendered_video`, closes the ledger row with the
  version id, lists next to the post's other versions unselected, and serves with Range; a
  non-MP4 render 400 with the ledger row `failed`; switch off → 503 on all three writes while
  viewing stays open.
- `tests/aliases.test.ts` passes with the two new `@shared/*` aliases in `wrangler.jsonc`.
- The gate chain (`npm run typecheck && npx eslint . && npx vitest run && npm run build`) is green;
  the editor is its own lazy chunk (`VideoEditor-*.js`, loaded by `lazyScreen` from PlanView and
  Workspace), so the main bundle does not grow by it.
- `scripts/video-editor-smoke.mjs` (Playwright, Chromium at `/opt/pw-browsers/chromium`, 390 px
  viewport): `npm run build && node scripts/video-editor-smoke.mjs`. It serves `dist/client`
  itself with the studio's boot calls answered by a small mock (a signed-in admin, no months), so
  no Worker, D1 or wrangler is needed; it opens `/video-editor`, asks the browser about its codecs
  on the served origin (WebCodecs exists only in a secure context, which `127.0.0.1` is), and
  checks that the editor mounts, that the stop message appears exactly when H.264/AAC are missing
  (and the Export panel shows it instead of the Export button), that the bottom toolbar shows the
  five panels, and that there is no uncaught error and no network call outside the server (the
  studio's Google Fonts are the one allowed host). Run here on 22 Oct 2026: the browser reported
  `webcodecs: true, h264: false, aac: false, h264decode: false`; the editor mounted; the stop
  message read "This browser cannot make an H.264 + AAC video. Use Chrome, Edge or Safari on a
  computer." with the three missing pieces listed under it; five tabs; no errors; `OK`.
  Screenshots at 390×844 and 1440×900 were looked at: the preview canvas fits the stage, the
  message sits over it, the transport, timeline and panels are where the layout says.

## What could not be verified here

- **Any H.264 path in a browser**: the Playwright Chromium has no H.264 decoder or encoder and no
  AAC, so the preview, the demux/decode cursor, the shader on real frames, the encoder, the muxer
  output and the end-to-end export were typechecked and reasoned through but not run. The first
  run on Chrome, Edge or Safari should: open a post with a finished clip, play it, trim, export,
  and check the new version's warnings line (it must say nothing about AAC or moov) and that the
  iPhone plays it. If `avc1.64002A` is refused on a machine, the check falls back to level 4.0
  and the Main profile strings.
- The 390 px one-panel layout was built on the Text Studio's conventions and checked by the smoke
  script only as far as the toolbar; a pass on a real phone is still due (as for the Text Studio).
- Performance figures above are estimates from the codecs' usual behaviour, not measurements.

## Limits

- Timelines up to 60 s, 24 clips, clips up to 60 MB each, 1080p output; 30 fps only.
- A clip from a saved project must still be loadable: a `version` source always is; an `upload`
  source (standalone mode) lives in the tab only.
- With music set, the clips' own sound is left out of the export; without music, their sound is
  kept (trimmed, sped, crossfaded). No mixing of both yet.
- Sources are drawn to cover the output frame (cropped, centred); no reframing or pan.
- The preview uses the browser's `<video>` decoding at up to 540×960; the export uses WebCodecs at
  full size. The colour shader is the same for both.
- The LUT is applied after the sliders and to the whole cut; per-clip colour is sliders only.
- Transitions: cut and crossfade. Text and logo stay out: that is the Text Studio's job.

## iPhone and Instagram

The output is what both want: H.264 High 4.0/4.2 `yuv420p`, AAC-LC 48 kHz stereo, `moov` first,
1080×1920 / 1080×1080 / 1080×1350 at 30 fps, 4–12 Mbit/s, under 60 s. Instagram re-encodes on
upload; a higher bit rate does not survive it, so "Good · 8 Mbit/s" is the sensible default. The
file is served by the studio's Range route like every version and plays inline on the approval
page once selected for the client.
