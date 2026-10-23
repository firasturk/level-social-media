# The video editor

A post's finished clips (Higgsfield versions, uploaded samples, the person's own footage) cut,
framed, titled, coloured and scored in the browser, rendered as an H.264 + AAC mp4 and stored as a
new version of the same post. "Save draft" keeps the editable project; "Render & update card"
renders a new version from the saved draft and, once it is uploaded, puts it on the Studio card
(and the client's link, unless the client approved the version they see).

Since the Video studio (docs/video-studio.md) the editor is that studio's **Edit** tool: the same
component (`src/video-editor/ui/VideoEditor.tsx`) carries the studio's rail (Presets, Generate,
Edit, Enhance, Audio, Versions, Check) around it. Opened with no post (`/video-editor`) the editor
shows the Edit tool alone and renders to a file.

## The video core (phase 1, 23 Oct 2026)

The foundation the later phases (timeline power features, templates, colour looks, reference
match, music library) build on. Layout after the studio's mock-up: a top bar "Level Studio / Video
studio / <post>" with the draft/render chip ("Draft saved · Render needed", "Rendering 42%",
"Rendered · on the card", "Render failed: …", "Render interrupted · Render again"), undo/redo,
**Save draft** and the primary **Render & update card**; above the stage the frame toggles
9:16 · 4:5 · 1:1 · 16:9 with Fill / Fit and the encoded size; under it the playback bar (play,
timecode, scrubber, before-colour, mute, full screen); the timeline with labelled Video, Text,
Logo and Music lanes; the panel tabs Media, Text, Logo, Music, Colour, Auto edit, Render. The
studio card shows **Edit video** over a clip it plays (the clapperboard under the T stays).

### 1. The reported bug: the size changed in the editor never reached the card

Reproduced in `tests/video-renders.test.ts` ("the reported bug, reproduced") and traced through
every step; the causes, in the order they bite:

1. **The render never became the card's video.** The card plays `client ?? newest finished`
   (`src/studio/VideoOnCard.tsx`), and an export only became the client's version when the post had
   none (`autoSelectForClient` in `storeVideoFile`). A post whose clip was already the client's
   (the usual case: the first finished clip goes there by itself) kept playing that clip after
   every export, so the card showed the old, differently framed footage while the editor showed
   the new frame. The new version existed, unselected, under Versions only.
2. **Nothing said so.** "Save cut" and "Export" did not say whether the card had changed, so a
   saved size looked like a done change. The editor's preview is the project; the card is a
   stored version: until a render lands they differ by design, and now the chip says "Render
   needed".
3. **A new cut opened in 9:16 whatever the clip was.** `newProject` defaulted to 1080×1920, so
   opening a 16:9 client clip showed a portrait preview next to a card playing landscape footage,
   before anything was changed. A new cut now opens in the frame of the clip it starts from.
4. **The card's label and poster described something else.** The badge's frame was the frame
   *asked for* at generation (an engine that follows the picture ignores it), and an export's
   poster was the post's picture. The frame now comes from the stored file's own width and height,
   and a render's poster is its own frame (the compositor's still).

What was checked and is not a cause: the saved project does carry the size (`output.width/height`,
validated, saved with its `rev`); the encoded size followed the project's output (the encoder and
the muxer were configured with it; now also asserted server-side: an upload whose `tkhd` size is
not the frozen revision's output is refused); the card's media URL is per version id
(`/file?id=`, `max-age` per immutable file), so no stale cache; the client link's URL is per post
and was cache-busted by `updated` only, now by version id and `updated` (`?v=<id8>.<updated>`).
The card's box keeps the post picture's frame and shows a clip with `object-fit: contain`, so a
9:16 render on a 4:5 card shows side bands: nothing is cropped or stretched there.

### 2. Save draft, and Render & update card

- **Save draft** = `PUT /projects/:id` with the tab's `rev` (409 on a stale tab, as before). The
  project keeps the sources, the timeline, the framing, the text and logo layers, the audio (the
  music is uploaded once as one of the post's licensed tracks, `video_audio`, and referenced by id,
  so a reopened draft sounds the same), the colour and the output settings. Reopening restores the
  project exactly (checked: reload → reopen keeps 9:16 and the text layer, `video-core-smoke`;
  validation round-trip, `video-compose.test.ts`). The LUT table is still not stored (its name is).
- **Render & update card**: the draft is saved if needed; `POST /renders {projectId, rev}` opens a
  **render job** (migration **0076**, table `video_renders`) for exactly that saved revision and
  copies its document into the row (frozen: later saves do not change what this job renders); the
  tab renders that document (the person can keep editing meanwhile), reports progress every two
  seconds (`/renders/:id/progress`, the heartbeat), uploads the file with its still and preview
  (`POST /render` with `renderId`), and the server closes the job and promotes the version.
- **Promotion** (`decidePromotion` / `promoteRender` in `server/video-editor.ts`): the card shows
  the done version with the highest `videos.card_rank` (new column, 0076). A render's rank is the
  time it *started*; an explicit choice ("Select for client review", "Send for review") ranks at
  the time of the choice. A finished render is promoted only when no version of the post has a
  higher rank and the card does not show a newer revision of the same project; the update itself
  is guarded in SQL, so two uploads landing together cannot both win. Outcomes: `card` (the card
  and the client link), `review` (the card, but the client approved the version they see: the
  client link keeps it until someone presses **Send for review**), `superseded` (kept as a version,
  replaces nothing). Approval stays attached to the exact version id the reviewer saw
  (`clientApproved`); an approval recorded before versions were sent is read as approval of the
  current one (the safe reading).
- **Failure and recovery**: a render that throws is recorded as failed with its reason; the card
  keeps its video (nothing is promoted before the upload succeeds). A job whose tab stops reporting
  for 90 s reads as **interrupted** (`RENDER_STALE_MS`): browser rendering cannot continue without
  its tab, so the Render panel says so and offers **Render again** (a new job of the current saved
  revision). The tab asks before closing while a render runs. Every earlier version stays.
- **Permissions**: starting, reporting, failing and uploading a render are admin-only behind the
  `editor` switch (`requireIntegrationAdmin`, `assertIntegrationEnabled`); members may list a
  project's jobs. Nothing calls a provider and nothing is spent (ledger rows at estimate 0).

### 3. One compositor for the preview and the render

`src/video-editor/engine/compose.ts` draws one frame of the timeline; the preview (`preview.ts`)
and the render (`export.ts`) both call it. Shared: the timing (`frameAt`: clip, source time,
crossfade mix), the framing (`shared/video-compose.ts`: Fill covers, Fit contains over the
background colour, zoom 1–4×, pan −1…1 across the overflow, one uniform scale so people and
products are never stretched), the display rotation, the layer order (background → clip(s) →
colour grade → text and logos, which are never graded), the colour (look + sliders + per-clip +
LUT, one WebGL2 shader), the text (the browser's text engine draws into a 2D layer at the same
fractions of the frame: Arabic is shaped and right-to-left, Latin left-to-right) and the logo. The
audio is the same mix definition: the preview's music now applies the volume and the fades the
render mixes. Only the picture source differs: hidden `<video>` elements for the preview,
WebCodecs frames for the render.

The frame toggles set the project's **encoded** size: 9:16 → 1080×1920, 4:5 → 1080×1350, 1:1 →
1080×1080, 16:9 → 1920×1080 (`FRAME_OUTPUT`); measured on the rendered files with mp4box and
ffprobe (below).

### 4. Rotation and colour on import

- **Rotation**: the track header matrix (`tkhd`) is read on import (`rotationOfMatrix`, signed or
  unsigned 16.16), 0/90/180/270 clockwise; the decoder hands out coded frames and the shader turns
  them (`codedUv`); the preview's `<video>` turns them itself. Measured: a phone-style clip (coded
  640×360, 90° matrix) renders upright in both. The light preview rendition
  (`src/lib/video-rendition.ts`) now turns it too. Mirrored or skewed matrices are drawn as coded
  (not handled).
- **Colour in**: the sample entry's `colr` (nclx) box is read; the decoder is told the file's
  primaries, transfer, matrix and range, or, when the file says nothing, the convention for its
  size (BT.601 below 720 lines, BT.709 above, limited range), which is what `<video>` players use.
  Without this the WebCodecs decoder labels an unlabelled stream BT.709 at any size and an SD clip
  rendered with other colours than the preview showed (measured before the fix: pure green 255
  came out 214). A bitstream VUI that contradicts a missing `colr` box is not read (limitation).
  HDR (PQ, HLG, BT.2020) is flagged in the Media panel and not tone-mapped.
- **Colour out**: every frame is converted on the GPU to I420, BT.709, limited range, and handed
  to the encoder as YUV (no second conversion in the encoder), and the file is tagged
  bt709/bt709/bt709/tv. Measured: tags present on all four frames; pure red, green, blue and grey
  come back within 4/255 when decoded with those tags.

### 5. Rendering foundation: extend the browser renderer, or embed/cloud

| | **This editor (extended)** | IMG.LY CE.SDK | Shotstack | Remotion (+ Lambda) |
| - | - | - | - | - |
| Preview = export | Same compositor and shader for both (measured, below) | Same engine in the browser; server export through their renderer | Browser preview (their Studio SDK) and a different cloud renderer: small differences possible | Same React components in the Player and the render |
| Arabic (shaping, RTL) | The browser's text engine: shaped, bidi (measured in the render) | Vendor text engine: to verify on a trial | Their text assets; RTL to verify | The browser's (headless Chromium): good |
| Timeline / templates | Our JSON project; lanes now; templates to build | Rich editor UI and templates out of the box | JSON edit spec with tracks; templates API | Code: templates are React components we write |
| Colour | Our shader: looks, sliders, LUT | Filters, LUTs | Basic filters | Whatever we write (CSS/WebGL) |
| Browser / mobile | WebCodecs: Chrome, Edge, Safari 16.4+ for video; WebCodecs **audio** encoding came to Safari much later (as we read WebKit's notes, Safari 26), so older iPhones stop at the capability message; long 1080p renders on a phone are slow and memory-bound | Also WebCodecs-bound in the browser; server renderer otherwise | No device limit (cloud) | No device limit (cloud) |
| Infrastructure / running cost | None (the person's machine); R2 storage only | Licence + optional render servers we run | Pay per rendered minute | AWS account, Lambda, S3; per-render cost plus our ops |
| Licence | Ours (mp4box BSD-3, mp4-muxer MIT) | Commercial licence required (pricing on request) | Commercial subscription | Free only for very small teams; a company licence is required for us |
| Portability | Our JSON (shared/video-project.ts) | Their scene format | Their edit JSON | Our props JSON + our components |

**Recommendation: keep and extend the browser renderer.** It already meets the requirements that
matter most here (preview and export identical, Arabic correct, colour controlled, 9:16/4:5/1:1/
16:9 at the right encoded size), costs nothing to run, needs no licence and keeps the project
portable. Nothing renders on Workers (CPU and time limits); a Worker only stores the result. What
it cannot do is render without the tab or on browsers without WebCodecs audio; if that becomes a
need, the next step is a server render of the **same** compositor (this engine bundle in a
branded headless Chrome in a container, with the same project JSON), not a second engine. A
commercial SDK or cloud API would only be worth a trial (no purchase made, none assumed free) if
the template phase needs an off-the-shelf template editor; its Arabic text must be tested first.

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

## Inside the post studios

Opened from a card, the editor is the Video studio's Edit panel: the unsaved cut (with its music
file and LUT, in memory) travels with the card's editing session when the designer switches to the
Photo or Text studio and back (`docs/photo-studio.md` → *Moving between editors*). Saving, the
render and the upload are unchanged and stay admin-only on the server (`requireIntegrationAdmin`).

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
  preview, transport, timeline, the panels (seven since the video core), top bar with undo/redo, Save draft, Render, Close;
  one panel at a time with a bottom toolbar under 860 px), `Timeline.tsx` (clip blocks, trim
  handles as one undo step per drag, beat ticks, playhead), `Panels.tsx` (Clips, Auto edit, Music,
  Colour, Export), `history.ts` (undo/redo with mark/patch/commit). Keys: space, ⌘Z/⇧⌘Z, ⌘S, S
  (split), Delete, ←/→ (a frame, ⇧ a second), Esc.
- Entry points: the clapperboard directly under the T on the Studio card (classic and compact
  cards; now on every post with a picture: it opens the Video studio on Generate, or on Presets
  when the post has no clip; the badge refreshes when an export lands); "Edit in the Video editor"
  per finished version in the Video dialog and in the editor's Versions group opens the studio on
  the Edit tool with that version on the timeline; `/video-editor` (the Sidebar's "Video editor")
  as a standalone screen with uploads only and a file download.
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
  one Edit tool with its five tabs inside the panel (the Video studio's layout with no post open),
  and that there is no uncaught error and no network call outside the server (the
  studio's Google Fonts are the one allowed host). Run here on 22 Oct 2026: the browser reported
  `webcodecs: true, h264: false, aac: false, h264decode: false`; the editor mounted; the stop
  message read "This browser cannot make an H.264 + AAC video. Use Chrome, Edge or Safari on a
  computer." with the three missing pieces listed under it; five tabs; no errors; `OK`.
  Screenshots at 390×844 and 1440×900 were looked at: the preview canvas fits the stage, the
  message sits over it, the transport, timeline and panels are where the layout says.

### The video core, verified on real files (23 Oct 2026)

`node scripts/video-render-check.mjs --out <dir>` runs the editor's engine (bundled on its own
from `scripts/video-render-check/harness.ts`) in the Playwright Chromium on fixtures made with
ffmpeg at test time (three colour bands 640×360 BT.709-tagged; one colour per second 640×360
with no colour tags; a phone-style clip, coded 640×360 with a 90° matrix showing a portrait
yellow-over-magenta picture; a cyan logo PNG; a 220 Hz music track), renders four projects and
inspects the files with mp4box and ffprobe/ffmpeg. The main project: clip 1 trimmed to the green
second of the colour clip, clip 2 the phone clip, clip 3 the bands in **Fit** over a grey
background, clip 4 the bands in **Fill** panned to the left edge; an English text layer 0–1 s and
an Arabic one 1–2 s (white on a black box), the logo 0–4 s, the music. Chromium here has no H.264
or AAC, so these renders use the engine's test codecs (VP9 + Opus in MP4); everything else is the
studio's path. Expected against observed, as printed by the run:

| Check | Expected | Observed |
| - | - | - |
| 9:16 encoded size (mp4box / ffprobe) | 1080×1920 | 1080×1920 / 1080×1920 |
| 4:5, 1:1, 16:9 encoded size | 1080×1350, 1080×1080, 1920×1080 | the same, on both tools |
| Audio track (all four) | present | opus 48000 Hz 2 ch |
| `moov` before `mdat` (all four) | yes | yes |
| Colour tags (all four) | bt709 / bt709 / bt709 / tv | bt709 / bt709 / bt709 / tv |
| 9:16 length, frames | 4.0 s, 120 at 30 fps | 4.02 s, 120 |
| Trim and order at 0.5 s (clip 1 = green second) | green across the frame | 0,252,0 (export) · 0,255,1 (preview) |
| Phone clip at 1.5 s, top / bottom | yellow / magenta (upright) | 253,238,0 / 254,38,254 (export) · 255,255,2 / 255,0,253 (preview) |
| Fit at 2.5 s: band, left, centre, right | grey / red / green / blue | 128,128,128 / 251,0,0 / 0,252,0 / 0,0,252 (export and preview alike) |
| Fill panned left at 3.5 s, centre and right | red, red | 251,0,0 and 251,0,0 (export and preview) |
| Logo at (0.85, 0.93), every second | cyan | 0,253,254 (export) · 0,255,255 (preview) |
| English text at 0.5 s (band y 0.10–0.14) | box > 20 %, white letters > 3 % | box 46.6 %, letters 34.0 % |
| Arabic text at 1.5 s | box > 20 %, white letters > 3 % | box 49.6 %, letters 18.1 % (and looked at: joined, right to left) |
| No text at 2.5 s (layer ended) | < 1 % | 0.0 % / 0.0 % |
| Sound level (the music) | mean above −30 dB | −25.4 dB |
| 4:5 / 1:1 crop of the bands at x 0.03, 0.5, 0.97 | red, green, blue (centred crop) | 251,0,0 · 0,252,0 · 0,0,252 |
| 16:9 at x 0.05, 0.5, 0.95 | red, green, blue (whole picture) | the same |
| Phone clip as read on import | rotation 90, 640×360 coded, 360×640 shown | the same |
| Tagged clip as read on import | BT.709 limited | BT.709 limited |
| Render time, 4 s at 1080×1920 (software VP9, headless) | | 15–19 s |

`node scripts/video-core-smoke.mjs` drives the real studio UI (the built app with a stateful mock
of the routes): the card's **Edit video** opens the editor in its clip's frame (16:9); the frame
bar, scrubber, mute and full screen are there; the lanes read Video, Text, Logo, Music; 9:16 turns
the stage to 540×960; a text layer is added; **Save draft** shows "Draft saved · Render needed";
after a page reload and a reopen the frame (9:16) and the text layer are back; **Render & update
card** shows "Rendering n%" then "Rendered · on the card"; the file the server received is
1080×1920 with an audio track, its job id and a still, after ten heartbeats; the card then plays
the new version's file and its badge reads "Video · 3s · Reel 9:16"; the 390 px layout does not
scroll sideways. Server rules (`tests/video-renders.test.ts`, in-memory D1/R2): the reported bug;
a frozen revision; the size guard; approval kept; out-of-order completion both ways; a choice made
during a render wins; interrupted and failed renders keep the card; members cannot render; the
card and the client link serve the same file. `tests/video-compose.test.ts`: the framing maths,
rotation, layers, colour assumptions and the project round-trip.

A 4-second sample render (VP9, 1080×1920), its still, an H.264 transcode for viewing and the
JSON report are kept outside the repo, under the session's scratchpad `video-sample/`.

## What could not be verified here

- **The H.264 + AAC encoders themselves**: the Playwright Chromium has none, so the demuxer, the
  decode cursor, the compositor, the I420 pass, the muxer and the upload were run end to end with
  VP9 + Opus (above), but the `avc`/`aac` encoder configuration was not. The first run on Chrome,
  Edge or Safari should render a post, check the new version's warnings line (nothing about AAC
  or moov), its size on the badge, and that the iPhone plays it. If `avc1.64002A` is refused on a
  machine, the check falls back to level 4.0 and the Main profile strings.
- The server's promotion was run against the in-memory D1, not production D1 (not touched).
- The 390 px one-panel layout was built on the Text Studio's conventions and checked by the smoke
  script only as far as the toolbar; a pass on a real phone is still due (as for the Text Studio).
- Performance figures above are estimates from the codecs' usual behaviour, not measurements.

## Limits

- Timelines up to 60 s, 24 clips, clips up to 60 MB each, 1080p output; 30 fps only.
- A clip from a saved project must still be loadable: a `version` source always is; an `upload`
  source (standalone mode) lives in the tab only.
- With music set, the clips' own sound is left out of the export; without music, their sound is
  kept (trimmed, sped, crossfaded). No mixing of both yet.
- Framing is Fill or Fit with zoom and pan per clip (no keyframed motion yet); Fit shows a plain
  background colour (no blurred copy yet).
- The preview uses the browser's `<video>` decoding at up to 540×960; the render uses WebCodecs at
  full size. The compositor (framing, colour, text, logo) is the same for both.
- The LUT is applied after the sliders and to the whole cut; per-clip colour is sliders only; the
  LUT table is not stored with the draft (its name is).
- Transitions: cut and crossfade. Text layers are words with a font family, weight, colour, box
  and position; no animation yet. Logos are one picture each (a brand-kit address or a small file
  of 200 KB at most).
- A render runs in its tab; closing the tab interrupts it (the job says so; Render again).

## iPhone and Instagram

The output is what both want: H.264 High 4.0/4.2 `yuv420p`, AAC-LC 48 kHz stereo, `moov` first,
1080×1920 / 1080×1080 / 1080×1350 at 30 fps, 4–12 Mbit/s, under 60 s. Instagram re-encodes on
upload; a higher bit rate does not survive it, so "Good · 8 Mbit/s" is the sensible default. The
file is served by the studio's Range route like every version and plays inline on the approval
page once selected for the client.
