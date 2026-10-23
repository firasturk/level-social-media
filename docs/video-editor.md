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
  validation round-trip, `video-compose.test.ts`). Since phase 3 the LUT table is stored with the
  draft too (below, *Phase 3*); a phase-1 draft kept only its name.
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
| Browser / mobile | WebCodecs: Chrome, Edge, Safari 16.4+ for video; WebCodecs **audio** encoding came to Safari much later (as we read WebKit's notes, Safari 26) and Chrome on Linux has none, so since 23 Oct 2026 the editor encodes AAC itself there (WebAssembly, "AAC without WebCodecs" below); long 1080p renders on a phone are slow and memory-bound | Also WebCodecs-bound in the browser; server renderer otherwise | No device limit (cloud) | No device limit (cloud) |
| Infrastructure / running cost | None (the person's machine); R2 storage only | Licence + optional render servers we run | Pay per rendered minute | AWS account, Lambda, S3; per-render cost plus our ops |
| Licence | Ours (mp4box BSD-3, mp4-muxer MIT) | Commercial licence required (pricing on request) | Commercial subscription | Free only for very small teams; a company licence is required for us |
| Portability | Our JSON (shared/video-project.ts) | Their scene format | Their edit JSON | Our props JSON + our components |

**Recommendation: keep and extend the browser renderer.** It already meets the requirements that
matter most here (preview and export identical, Arabic correct, colour controlled, 9:16/4:5/1:1/
16:9 at the right encoded size), costs nothing to run, needs no licence and keeps the project
portable. Nothing renders on Workers (CPU and time limits); a Worker only stores the result. What
it cannot do is render without the tab (browsers without WebCodecs audio are covered by the AAC
fallback since 23 Oct 2026); if that becomes a need, the next step is a server render of the **same** compositor (this engine bundle in a
branded headless Chrome in a container, with the same project JSON), not a second engine. A
commercial SDK or cloud API would only be worth a trial (no purchase made, none assumed free) if
the template phase needs an off-the-shelf template editor; its Arabic text must be tested first.

## Phase 2: the timeline, auto edit and music sync (23 Oct 2026)

Branch `video-timeline` (from `studio-direct` at `dcf884a`). Everything below goes through the one
compositor (`engine/compose.ts`) and the one mix definition (`shared/video-mix.ts`), so the
preview and the render agree; nothing renders on a server, nothing calls a provider.

### Implemented

**Project document version 2** (`PROJECT_VERSION = 2`, `shared/video-project.ts`). New, all
optional so a template or an older tab can omit them: per clip `volume` (0–1), `muted`, `locked`,
`speech` ("has speech"), `keyframes` (pan x/y and zoom); transitions `dipBlack` and `dipWhite`
besides cut and crossfade; gaps (`source: { kind: "gap" }`, an empty stretch of background);
`music.start` / `music.end` (its place on the timeline; `offset` is now the track second at
`start`) and `music.duck { enabled, level }`; `voices[]` (voice-over recordings: source, start,
in/out, volume); on text layers `second` (the other language's line), `opacity`, `keyframes`; on
logos `keyframes`. **Migration**: `validateProject` reads a version 1 document as version 2
(`migrateV1`): a v1 draft with music gets its clips muted (v1 left the clips' sound out under
music, so it renders exactly as before), the music starts at 0 with ducking off, no voices. The
server stores what `validateProject` returns, so drafts and frozen render documents saved before
open and render unchanged; the next Save writes version 2. Rev/409 and the frozen render
revisions are untouched.

**Timeline** (`ui/Timeline.tsx`, maths in `shared/video-timeline.ts`):
- Lanes **Video, Text, Logo, Music, Voice**, labelled; a toolbar with Split, Ripple delete
  ("Ripple"), Delete leaving a gap ("Gap"), Lock, snapping (magnet), zoom out / fit / in, the
  timecode field and frame steps.
- Selection: click; **shift-click** a run; **cmd/ctrl-click** to add or remove one. Several
  clips can be dragged, deleted, locked or muted together.
- **Reorder by drag** (the selection moves together; a marker shows where it lands); **trim** by
  the clip's ends; **split at the playhead** (S; keyframes split so neither half jumps).
- **Ripple delete** (Delete) closes the gap and moves the text, logo and voice-over that start
  after it left with the footage; **delete leaving a gap** (Shift + Delete) puts a gap of the same
  length, so nothing else moves (neighbouring gaps join; a gap at the very end is dropped).
- **Snapping** to the playhead, cuts, beats and the edges of text, logo, music and voice blocks,
  within 8 px at any zoom; the magnet turns it off; **hold Alt (Option)** while dragging to
  place freely. A thin line shows what it snapped to.
- **Zoom**: buttons, ctrl/cmd + wheel and trackpad pinch around the pointer, two-finger pinch
  on touch; "Fit" shows the whole cut. 4 px/s (a minute on a phone) to 480 px/s (16 px a frame).
- **Timecodes** mm:ss:ff at 30 fps in the transport and the toolbar; the field takes
  `mm:ss:ff`, `mm:ss`, `12.5` or `4s`. ←/→ one frame, Shift ← / → one second, ↑/↓ the
  previous / next cut, L lock.
- Text, logo, music and voice blocks move by drag and trim by their ends; trimming the music's
  head keeps the music where it was (the track starts later by the same amount).
- **Keyframes** show as diamonds on their block; a click moves the playhead there.

**Per clip** (Media panel): speed (×0.25 … ×4 as before), **sound: keep / mute and volume**,
**Lock** (auto edit, beat alignment and dragging never move or trim it), **Has speech**, the
join: **a cut, a crossfade, a dip to black, a dip to white** (0.2–2 s; a dip covers the footage
and its background fully at the cut and fades linearly on both sides; text and logos stay on
top; the clips' sound dips with it), framing with **keyframed zoom and pan**.

**Text** in Arabic, English or **bilingual** (a second line in the other language). Each
paragraph takes its own direction, so the Arabic line is shaped and runs right to left and the
English line left to right, in the preview and the render (the browser's text engine, canvas
`direction` per line). "Start"/"End" alignment follows each line's direction. Opacity per layer.

**Keyframes** (`shared/video-keyframes.ts`, panel `ui/KeyframeControls.tsx`): position (x, y),
scale and opacity on text and logo layers; pan (x, y) and zoom on a clip's framing. A diamond
sets or removes a keyframe at the playhead; once a property has a keyframe its slider sets the
keyframe at the playhead. Linear, ease in, ease out, ease in and out (the easing of a keyframe
is how it travels to the next one); held before the first and after the last. Below full
opacity a text layer is drawn whole and laid on at its opacity, so two lines' boxes fade as one.

**Sound** (`shared/video-mix.ts`, `engine/audio.ts`): the clips' own sound **is mixed with the
music** now (each clip at its volume; fading under crossfades and dips); the music plays from its
`start` to its `end` with volume, fade in and fade out; **ducking**: under every clip marked "has
speech" and every voice-over the music goes down to its duck level (default 30 %), starting
0.2 s before the words and back over 0.4 s after (sidechain-style). The music's whole gain is one
curve sampled at 100 per second (`musicGainCurve`); the offline mix and the preview hand that same
curve to Web Audio (`setValueCurveAtTime`). The preview plays each clip's sound from its
`<video>` at the level `clipGainAt` gives for the frame. **Voice-over**: Music tab → Voice-over,
a recording from the computer on the Voice lane at the playhead, its own volume; with a post
open it is kept with the post's audio (licence line "Voice-over recording") so a reopened draft
plays it.

**Auto edit** (`shared/video-autoedit.ts`, `planFirstCut`, panel `ui/AutoEditPanel.tsx`), still
heuristics from motion energy, deterministic:
- inputs: purpose (Product launch, Promo, Story), target length, pace (Calm 2–6 s shots with
  0.5 s crossfades; Balanced 1.2–3.5 s, cuts, short crossfades for a story; Energetic 0.8–2.5 s,
  cuts), the music's beats when set (shot lengths in whole beats);
- purpose: a launch opens on the liveliest clip, keeps the rest in order, and ends on a held
  shot after a dip to black; a promo runs liveliest first; a story keeps the footage's order;
- **locked clips** stay exactly where they are: the planner fills the time before, between and
  after them and corrects the shot before each to land on its second; if the footage cannot fill
  a stretch, a gap is left and the panel says so;
- **protected speech**: the source seconds of clips marked "has speech" come back whole (never cut
  inside, joined by cuts so the words do not fade), and no other shot takes a window that
  overlaps them;
- the result is an ordinary editable timeline; undo brings back the previous one.
- **Beat markers** show on the ruler and the Music lane; **Align cuts to beats** (Music) moves
  each cut within 0.25 s of a beat onto it by a roll edit (the clip before ends later or earlier,
  the clip after starts at the matching second), so the total length and the other cuts stay;
  cuts next to a locked clip, speech or a gap, or with no footage to give, stay where they are
  (the toast says how many).

**Undo / redo** covers every operation (`shared/video-history.ts` + `ui/history.ts`): each commit
is one step; a drag (mark, patches, commit) is exactly one step, and a drag or a commit that
changes nothing records none (phase 1 recorded an empty extra step after every drag); text and
colour fields record one step per edit.

**Recoverable autosave** (`shared/video-drafts.ts`, `ui/autosave.ts`): while there are unsaved
changes, a copy goes to this browser's local storage every 4 s, keyed `lsm-video-draft:<project
id>` (or `new:<batch>:<post>` before the first save) with the revision it was edited from. On
reopen, when the copy differs from the server's draft and was written after its last save:
"Recover unsaved changes from 14:05? They were kept in this browser and never saved to the
studio." (plus, when the draft was saved again since, that recovering then saving would replace
that save). **Recover** puts it on the timeline as unsaved changes (undo goes back to the server's
draft); **Keep the saved draft** sets the copy aside (one backup, not offered again). Nothing is
written to the server without Save; a successful Save clears the copies. At most 8 copies are kept.

**Wording**: the Music tab says the track is mixed with the clips' sound, that it is not
Instagram's music library, and that "Instagram's own music can only be added in the Instagram
app when posting."

**Permissions** are unchanged: every write is the existing admin-only routes behind the `editor`
switch; members open read-only (the timeline and panels' controls disabled, autosave and the
recovery question off).

### Verified, and how

- **Unit tests** (vitest, no browser): `tests/video-timeline.test.ts` (35 tests: timecode
  format/parse/frame steps, zoom maths and ruler spacing, snapping targets/time/span, selection,
  multi-clip reorder and drop index, split with keyframes, ripple and plain delete (layers and
  voice moved, gaps joined), dips, keyframe easing/interpolation/set/remove/split/overlay and
  clip framing at t, saved-keyframe checks, bilingual direction, beat alignment with locks and
  speech, clip levels under crossfade/dip/mute, speech spans, the ducking envelope, the music's
  gain and curve, auto edit by purpose and pace, on beats, with locked clips (exact seconds and
  the gap note) and protected speech, determinism, the version 1 → 2 migration and the v2
  round-trip); `tests/video-autosave.test.ts` (11: undo stacks incl. one-step drags, the recovery
  rule, keys, storage write/read/aside/clear/cap). The earlier suites pass unchanged except the
  "unknown version" case, now `v: 99`. Whole suite: 113 files, 953 tests green.
- **Gate chain** green: `npm run typecheck && npx eslint . && npx vitest run && npm run build`.
- **A real render** (`node scripts/video-phase2-check.mjs --out <dir>`, Playwright Chromium,
  VP9 + Opus as the earlier checks): clip A (red second, green second, 440 Hz) split at 2 s and
  its red half ripple-deleted; clip B (blue, 660 Hz) joined by a 0.5 s crossfade; clip C
  (yellow, 880 Hz, muted) after a 0.6 s dip to black; a bilingual text (Arabic "عرض خاص" over
  "Special offer", Tajawal 800, the studio's Arabic font, served to the page) with keyframed
  opacity 0 → 1 and y 0.25 → 0.20 over its first half second; a logo with scale keyframed 0.5 →
  1.5 over 6 s; music (220 Hz) at 0.8 with 1 s fades, ducked to 0.2 under a voice-over (1 kHz).
  Inspected with ffprobe, frames extracted with ffmpeg (PNG, looked at), tones measured with a
  Goertzel filter on the decoded sound:

| Check | Expected | Observed |
| - | - | - |
| Edits (editor's own functions) | 3 clips; text moved 2.3 s → 0.3 s; voice 5.0 → 3.0 s | 3 clips; text 0.3–3.0 s; voice 3.0 s |
| Encoded size | 1080×1920 | 1080×1920 |
| Duration = timeline | 6.5 s, 195 frames | 6.52 s, 195 frames |
| Audio track | present | opus 48000 Hz 2 ch |
| Text at 0.30 s (opacity key 0) | no box | 0 rows |
| Text at 0.55 s (opacity 0.5) | half-dark box over green | 59.6 % of the band |
| Text at 1.00 s | full box, two lines | 220 rows |
| Text y at 0.55 s / 1.00 s | 432 px / 384 px | 427 px / 382 px |
| No text at 3.5 s (ended at 3.0 after the ripple) | none | 0 rows |
| 0.30 s picture (red half deleted) | green | 0,252,0 |
| 1.75 s crossfade half way | ≈ 0,128,128 | 0,117,134 (preview 0,127,126) |
| 4.35 s dip half way | ≈ 0,0,128 | 0,0,111 |
| 4.50 s at the cut | black | 0,0,0 (preview 0,0,0) |
| 5.50 s | yellow | 251,251,0 |
| Logo width at 1.0 s / 5.0 s (scale 0.667 / 1.333) | 108 px / 216 px | 108 px / 216 px |
| Music 1.5–2.5 s (0.8, not ducked) | 0.100 | 0.1003 |
| Music under the voice-over 3.3–4.2 s | 0.2 × | 0.0199 (0.20 ×) |
| Music fade in 0–0.3 s / fade out 6.2–6.5 s | ≈ 0.015 / < 0.35 × | 0.0151 / 0.15 × |
| Clip A sound at 50 %, mixed with music | 0.0625 | 0.0623 |
| Clip B sound at 100 % | 0.125 | 0.1248 |
| Clip C muted | 0 | 0.0000 |
| Voice-over inside / before | 0.125 / 0 | 0.1251 / 0.0000 |
| Arabic in the render | joined, right to left, above the English line | looked at (frame-1.00s): "عرض" on the right, "خاص" on the left, letters joined; English left to right below |

  The preview (same compositor, hidden `<video>` elements) matched at the crossfade, the dip,
  the logo and the text box; its canvas at 1.0 s was looked at too. Render time 31 s for 6.5 s at
  1080×1920 (software VP9, headless).
- **The real UI** (`node scripts/video-core-smoke.mjs`, the built app with a stateful mock): the
  lanes read Video, Text, Logo, Music, Voice; the timecode field seeks to 00:01:15; split → 2
  clips, undo → 1, redo → 2; shift-click → "2 clips selected"; delete leaving a gap → 2 blocks, 1
  gap; ripple delete → 1 clip, no gap; lock → 1 locked; zoom in ×2.25 then Fit back to the same
  width; a bilingual line and an opacity diamond on the Text lane; after 5 s the local copy
  `lsm-video-draft:p1` exists; a reload without saving asks "Recover unsaved changes from
  HH:MM? …" with the server's revision untouched; Recover brings back 2 clips, the lock and the
  second line with "Unsaved changes · Render needed"; Save clears the copy and stores a version 2
  document (2 clips, 1 locked, `second`, opacity keyframes); Render & update card then renders
  1080×1920 with audio and the card plays it; at 390 px nothing scrolls sideways, the timeline's
  toolbar and five lanes fit. Screenshots at 1440 and 390 were looked at.
- The phase 1 checks still pass (`video-render-check.mjs`, `video-editor-smoke.mjs`).

### Not verified

- H.264 + AAC (the Playwright Chromium has neither; as in phase 1, everything else ran with
  VP9 + Opus). The preview's sound (clip levels through `<video>.volume`, the music curve and the
  voices through Web Audio) was not listened to: the curve is the render's own (tested), the
  scheduling of `MixPreview` was not measured.
- Touch pinch-zoom and drag on a real phone; trackpad pinch on a Mac (ctrl + wheel was the path
  exercised in code, not in the smoke).
- A real person's speech: "has speech" is a flag the person sets; nothing detects speech.
- The 390 px top bar is crowded (the chip runs under undo/redo); it predates phase 2.

### Limits (phase 2)

- One video lane: clips play one after another (crossfades overlap two); no picture-in-picture,
  no free-floating clips. Gaps are clips of background.
- Keyframes: position, scale and opacity on text and logo layers, pan and zoom on clips; no
  rotation, no curves editor, no per-letter animation. A clip's keyframes are in seconds from its
  start, so trimming its head shifts them with it.
- Transitions: cut, crossfade, dip to black or white, nothing else (on purpose).
- Ducking follows the "has speech" flag and the voice-over lane, not the sound itself. One duck
  level for the whole cut.
- Up to 8 voice-overs. A voice-over or music file picked in the standalone editor lives in the
  tab only (as in phase 1).
- Autosave is this browser's local storage only (not another computer, not a private window).
## Phase 3: looks, templates, reference match, music library (23 Oct 2026)

Built on the video core; everything below goes through the one compositor and shader, so the
preview, the thumbnails and the render draw the same colour. Nothing is generated, nothing calls a
provider, nothing is charged.

### Implemented

- **Colour presets** (`LOOKS` / `PRESET_IDS` in `shared/video-project.ts`): Clean, Warm Film, Cool
  Editorial, Soft Matte, Bold Sport (originals, sets of slider values; plus None and Mono). Each has
  an **intensity** 0–100 % that scales every parameter toward the preset (`presetParams`). The
  phase-1 looks keep their ids and values (`warm`, `cool`, `matte`, `punch` are marked *earlier
  look* and point to their successors; `clean` is unchanged), so a saved draft renders exactly as
  before; the auto edit's "clean"/"punch" still resolve.
- **Scope** (`shared/video-looks.ts`): *This clip* (the selected one, else the one under the
  playhead), *Chosen clips* (ticked in the panel, so it does not depend on the timeline's selection)
  or *Whole video* (the project's look; clears the clips' own presets, keeps their sliders and
  matches). A clip's own preset is `clip.look {id, amount}`. Each clip of a crossfade is now graded
  with its own grade (phase 1 used the outgoing clip's for both).
- **Correction sliders**: exposure, contrast, saturation, vibrance (new), temperature, tint,
  highlights, shadows, whites (new), blacks (new); per scope.
- **Thumbnails** (`ColourPanel.tsx`, `engine/looks.ts` `ThumbRenderer`): None + the five presets
  drawn from the current frame of the clip in scope (its framing, sliders and match included) by
  one small shared WebGL2 grader; redrawn when that clip, its colour or the frame shape changes
  (not on every playhead move).
- **Before/after**: hold *Before* (and the transport's button) for the footage untouched; *Split*
  shows before colour left of the middle and after on the right with a dividing line (a shader
  uniform; the preview only, a render never sets it).
- **Protect skin tones** (`protectSkin`, project-wide): a **hue-range heuristic** in the shader,
  not skin detection. A pixel whose original colour is in the warm band where skin tones fall
  (HSV hue about 0°–45° around 20°, saturation about 10–70 %, not near black) gets a weight 0…1;
  there the grade keeps its brightness but the colour part goes back to the original's hue, its
  size limited to ±15 % of the original, blended at 90 % of the weight. Wood, sand, terracotta and
  beige products in that band are protected too; skin under coloured light is not.
- **Match colour to a reference** (`MatchColour.tsx`, `shared/colour-match.ts`): the reference is
  a picture saved in the studio (the post's pinned reference, the theme's Pinterest pins and
  uploads, read through their existing read-only routes), a photo from the client's Drive (the
  studio's read-only `/api/studio/drive/photo/:id`; the Drive file is never changed) or a picture
  from this computer (kept in the tab; only an 8 KB thumbnail goes into the draft). Each clip in
  scope is measured on **five frames spread over the clip** (a hidden `<video>` of its own),
  pooled, and a **Lab mean/spread transfer** (Reinhard) is fitted **once**: per channel a scale
  (bounded, L 0.6–1.6, a/b 0.5–2) and an offset. It is stored on the clip (`clip.match`: scale,
  offset, strength, frames, and the reference's kind, id and name) and applied by the shader to
  every frame, before the preset and sliders; the same fixed transfer on every frame, so no flicker.
- **LUT kept with the draft**: loading a `.cube` stores its table in the project (`lut.data`,
  8-bit RGB as base64; tables above 33³ are resampled to 33³, ≈144 KB of text at most, inside the
  512 KB a save may weigh). Reopening restores it; the render uses the draft's table with no file
  loaded. A phase-1 draft (name only) asks for the file once and then keeps it. The shader now
  samples the table at texel centres (0 and 1 hit the first and last entries), matching
  `sampleCube`.
- **Templates** (`shared/video-templates.ts`, `TemplatesGallery.tsx` at the top of the Media tab):
  six originals: Product launch, Food close-up, Fashion/sport beat montage, Offer/promotion,
  Testimonial with captions, Minimal brand story. Each is a recipe: shot slots (label, hint,
  suggested length, framing, join), text layers with placeholder English and Arabic copy, the
  logo's place, a preset and intensity, skin protection, a pace and a music hint (moods, BPM).
  *Use this template* (admins; confirm when the cut is not empty; undo restores it) fills an
  ordinary project with the footage at hand (reused, each use a different window, when there is
  less footage than slots), texts in Arabic + English (stacked by their estimated lines so they
  never overlap), English or Arabic, and the client's logo when the brand kit has one; the
  project keeps `template {id, at}`. The gallery's thumbnails are schematics drawn from each
  definition (text and logo places in a 9:16 frame, the shots as a strip). Applying a template makes
  the cut a 9:16 Reel (1080×1920) by default; when the cut is in another frame a "Keep W×H" choice
  keeps it (positions are fractions; written for 9:16).
- **Music library in the Music tab** (`MusicSourcePanel.tsx`; docs/music-library.md §6): new
  sources `{kind:"catalog", trackId}` and `{kind:"library", trackId, client}` with the licence,
  credit line and Content ID kept on the project; the rights block shows the credit the caption
  must carry for CC BY tracks (Copy button) and the Content ID note. Older `audioKey`/`upload`
  sources are unchanged.
- **Schema**: `PROJECT_VERSION` 2 → **3** (phase 2 took 2). `validateProject` migrates step by
  step (`migrateProject`): 1 → 2 is phase 2's `migrateV1` (sound and timeline), 2 → 3 is
  `migrateV2` (`lookAmount` 1, `protectSkin` false; new sliders default to 0; no clip look/match;
  a LUT without `data`), so phase-1 and phase-2 drafts open and draw the same picture; a version
  newer than the code is refused with "saved by a newer editor". The engine also draws a raw older
  document the same way (missing fields resolve to the earlier values).
- **Permissions**: no new server route. Saving (look, match, LUT table, music source, template)
  stays the existing admin-only `PUT/POST /projects`; members see the thumbnails, browse
  references and the library, and cannot apply or save. The editor gets two new props from
  `PlanView`: `client` (Drive and the client's tracks) and `references`.

### Verified, and how

- `tests/video-looks.test.ts` (30 tests): presets and the intensity blend (0 %, 60 %, 100 %,
  monotonic distance), vibrance, per-clip grade resolution, scope (clip, chosen, whole video); skin
  weight on four skin tones vs five non-skin colours, hue kept under a harsh cool grade, brightness
  kept, other colours untouched; Lab round trip, exact pooling of frames, a fit that brings a cool
  synthetic picture within 15 % of a warm reference's statistics, **stability**: fits on two
  different sets of five frames of a flickering, grainy clip differ by < 0.03 in scale and < 1.5
  Lab in offset (less than half the spread of single-frame fits), bounded scales, match
  validation; LUT serialise/parse to 8-bit precision, 40³ → 33³ resampling keeping its effect,
  refusal of mismatched or oversized data, a 33³ project under 200 KB; all six templates valid
  through `validateProject` for footage/no footage × en/ar/both × with/without logo, Arabic over
  English without overlap in 9:16, 4:5, 1:1, 16:9; music sources (CC BY catalog with credit and
  Content ID, library with client, refusals: bad id, NC licence, missing credit, unknown status);
  a version-1 draft migrated with the same grade as phase 1, a version-2 (phase 2) draft migrated to 3 with its phase-2 fields kept.
- `tests/video-looks-server.test.ts` (4 tests, in-memory D1/R2, paid-route guard: zero network): a
  v1 draft saved and read back as the current version (3) (and a v1 row in the database still opens); the LUT table, a
  match, clip presets, the template and a catalog source given back exactly; a 33³ table accepted,
  mismatched data refused (400); a member's save 403 with nothing written.
- The gate chain is green: `npm run typecheck && npx eslint . && npx vitest run && npm run build`
  (after merging phase 2: 115 files, 987 tests).
- `node scripts/video-looks-check.mjs --out <dir>` (Playwright Chromium, VP9 + Opus, fixtures made
  with ffmpeg: flat colour bands with grain, a warm reference PNG; the catalog's generated test
  loop served on the music library's file route). 56 checks, all passing on 23 Oct 2026. Expected
  against observed, as printed:

| Check | Expected | Observed |
| - | - | - |
| Template render (Product launch, 5 shots, AR+EN texts) | 1080×1920, 9.10 s, audio | 1080×1920, 9.12 s, Opus 48 kHz, mean −19 dB |
| Preview vs render, whole-frame mean, one time per shot | within 4/255 | Δ 2.10 · 1.91 · 2.63 · 2.15 · 2.18 |
| Preview pixel = CPU twin of the shader (16 points) | ±4 | 0–1 off everywhere |
| Render pixel = CPU twin (16 points) | ±12 | ≤ 4 off on 14 points; 8 and 9 on the two most saturated Bold Sport points (skin 252,189,132 vs 255,197,130; slate 66,107,165 vs 75,105,164): the render's own decode and the encoder's chroma on grain, since the preview (same shader) matches the twin |
| Warm Film 60 % on the scene | R−B grows | 2 → 15 |
| Bold Sport on the portrait (skin, red product, white) | the CPU twin | 252,189,132 / 253,0,0 / 253,253,253 vs 255,197,130 / 253,0,4 / 255,255,255 |
| Match: Lab distance of the rendered frame to the reference | after < ½ before | 58.3 → 3.6 (a* −2.0 → 17.0 vs 18.6; b* −16.3 → 33.3 vs 35.2) |
| Match fitted once | 5 frames | 5 frames, scale 1.072/1/1.256, offset 12.9/21.4/54.5 |
| LUT from the saved draft, no file loaded (4 points) | the CPU twin ±8 | ≤ 3 off |
| 40³ LUT stored | 33³ | 33³, 143,748 characters |
| Skin protection, skin patch hue under a harsh cool grade | on < ½ of off | raw 27.1°, off 34.2° (7.1°), on 24.8° (2.4°); red product and slate identical on/off |
| Thumbnails from one frame | warm > none > cool (R−B), 6 distinct | 65 > 47 > 42, 6 distinct |
| Split view | left = before, right = after | equal to the pixel |

  The frames (render and preview at each time), the contact sheet of the thumbnails, the match
  before/after, the skin on/off, the LUT frame, the split view, the VP9 render with an H.264
  transcode for viewing and `report.json` were looked at and are kept outside the repo in the
  session's scratchpad `video-phase3/`. `node scripts/video-render-check.mjs` and
  `node scripts/video-core-smoke.mjs` (phase 1) and `node scripts/video-phase2-check.mjs` (phase 2) still pass with the new shader after the merge (dips, keyframed opacity and the mix unchanged).
- `npm run build && node scripts/video-looks-smoke.mjs` drives the real UI (built app, stateful
  mock): six templates with schematics; Product launch fills 5 shots after the confirm; six
  distinct thumbnails; Warm Film at 60 %; Split; the match to the post's reference ("Matched to
  Sunset pin · 5 of 5 clips"); the library lists the catalog, a pick shows the rights block; Save
  draft stores v3 with `look`, `lookAmount` 0.6, `template`, five matches with their reference and
  the `catalog` source with credit and Content ID; after a reload and reopen Warm Film 60 % and the
  track are back (read again from the file route); at 390 px the Colour, Media and Music panels do
  not scroll sideways (screenshots looked at).

### Not verified here

- H.264/AAC encoding of these grades (the Playwright Chromium has none; as phase 1).
- Real footage and real faces: the presets were tuned by eye on flat test bands and the skin rule
  was checked on patches, not on people; the match on real Pinterest pins and Drive photos (the
  routes were mocked in the UI smoke; the Drive listing and photo routes were not called live).
- A real phone (touch on sliders, the 390 px layout beyond screenshots), Safari.
- The thumbnails' cost on a slow phone GPU (one 120 px pass per preset, measured only headless).

### Limits

- The match is a global Lab statistic, not scene understanding: a reference with different content
  transfers its cast too; strength 0–100 % and Protect skin tones are the brakes.
- Skin protection is a hue band; it is project-wide (not per clip).
- One LUT per cut, after the sliders, stored at 33³ and 8-bit at most.
- A template's music hint is advice: the music is not picked or generated for you. With music set,
  the render uses the music instead of the clips' sound (phase 1 limit), so the testimonial
  template says to leave music off.
- An uploaded reference picture is not stored: the match keeps working (its numbers are stored),
  but re-fitting needs the picture again.

### Decisions for the owner

1. **Credit line placement**: the editor shows and copies the credit; it does not write it into
   the post's caption. Confirm the caption (Instagram) / description (YouTube) placement and
   whether it should be added automatically when a CC BY track is used.
2. **Content ID tracks**: Kevin MacLeod's tracks are registered on purpose (claims released after
   the credit); keep offering them for clients who post on YouTube, or prefer CC0 there.
3. **Preset values**: the five presets are starting points tuned on test footage; a pass on the
   clients' real footage may adjust them (values live in `LOOKS`).
4. **Templates in other frames**: templates keep the cut's frame; say if a template should switch
   a new cut to 9:16.

## AAC without WebCodecs: the WebAssembly fallback (23 Oct 2026)

**The problem.** The render needed the browser's WebCodecs AAC encoder (`mp4a.40.2`) and stopped
without it. Measured on 23 Oct 2026: Google Chrome 156 on Linux has H.264 encode and decode in
WebCodecs but **no AAC `AudioEncoder`** (`isConfigSupported` answers `supported: false`); Safari
before 26 has no `AudioEncoder` at all (as we read WebKit's notes; not run here). A team member on
either could not render.

**What happens now.** When the browser has H.264 (encode and decode) but no AAC encoder, the
capability check says `audioEncoder: "wasm"` instead of stopping, the Render panel shows "This
browser has no built-in AAC audio encoder, so the editor encodes the sound itself: the first
render downloads its encoder (0.6 MB). The file is the same H.264 + AAC mp4.", and the render
encodes the already-mixed sound (the same `renderMix` as always) with FFmpeg's AAC-LC encoder
compiled to WebAssembly. The progress line reads "Encoding audio…" during that step. The output
is unchanged in kind: H.264 High + AAC-LC 48 kHz stereo 128 kbit/s in an MP4 with `moov` first.
Browsers with a native AAC encoder (Chrome/Edge on Windows and Mac, Safari 26+) keep the native
path untouched, and the test codecs (VP9 + Opus) are untouched. A browser with no H.264 still gets
the stop message. Saving and rendering stay admin-only on the server, as before.

### How it is put together

- `scripts/aac-wasm/aac_wrapper.c` + `scripts/aac-wasm/build.sh` → `src/video-editor/engine/aac-encoder.wasm`
  (628 KB, 233 KB gzip). FFmpeg 8.1.3 as released (sha256 pinned in the script), configured with
  `--disable-everything --enable-encoder=aac` and no external library, compiled with clang for
  `wasm32-wasi` against wasi-libc (no Emscripten runtime: the glue is `shared/aac-wasm.ts`; Ubuntu packages `clang lld
  wasi-libc libclang-rt-18-dev-wasm32`). The script refuses a build whose `config.h` says GPL.
  The build is reproducible: a second build in a fresh directory gave the same bytes (sha256
  `3947865693d8afb624ee57cd8c71bdc22f4f5abebff7b2721c898c8d5b72fb02`).
  The wrapper exports `aac_open`, `aac_input` (the encoder frame's planar float buffers),
  `aac_encode` (one frame, or a flush) and readers for the packets; the encoder writes **raw access
  units** (no ADTS, so there is no header to strip) and its own AudioSpecificConfig.
- `shared/aac-wasm.ts`: instantiates the module (each render gets a fresh instance), answers the
  dozen WASI imports libavutil links with "nothing there" (no file, no environment is ever used),
  feeds 1024-sample frames, collects units with their sample times. DOM-free, so the Node tests run
  the real encoder.
- `shared/aac-mp4.ts`: the AudioSpecificConfig built and read (`11 90` for AAC-LC 48 kHz stereo;
  FFmpeg's own `11 90 56 e5 00`, which adds an explicit "no SBR", must start with the same two bytes
  or the render stops), each unit's time (unit *i* at *i* × 1024 samples, rounded to µs from the
  sample count so nothing accumulates; the muxer turns them back into exact 1024 deltas), and
  `addEditList`.
- `src/video-editor/engine/aac-fallback.ts`: loaded with `import()` only by a render that needs it
  (its own 4 KB chunk); fetches the wasm once per tab (a failed download is retried on the next
  render), encodes the mix, yields to the page every 64 frames so progress and Stop work, and hands
  the units to `mp4-muxer` (`addAudioChunkRaw`, the decoder config with the two-byte ASC on the
  first). `export.ts` picks this path when `caps.audioEncoder === "wasm"`.
- **Priming and sync.** FFmpeg's encoder starts 1024 samples early (its first unit is at −1024).
  `mp4-muxer` writes no edit lists, so after `finalize()` the file gets an `edts`/`elst` on the
  sound track (one segment: media time 1024, duration = the mix's length): the 1024 priming
  samples and the padding after the last sample are not played, exactly as FFmpeg and iPhone write
  their own AAC files. The box is inserted after `tkhd`; `trak`, `moov`, the track and movie
  durations and every `stco` chunk offset (moov is in front of mdat) are moved by its 36 bytes.
- Hosting: the wasm is a Vite asset (`/assets/aac-encoder-<hash>.wasm`), embedded into the Worker
  with the rest of `dist/client` by `scripts/embed-assets.mjs` (now typed `application/wasm`) and
  served same-origin with the immutable cache header. No CDN and no new host: the studio's pages
  send no Content-Security-Policy today; if one is added it needs `'wasm-unsafe-eval'` in
  `script-src` for this. The embedded asset module grows from 4,431 KB to 5,250 KB (gzip 1,835 →
  2,134 KB, +0.3 MB compressed).
- Failure is recoverable: a failed download says "The audio encoder could not be downloaded …
  render again" (the render fails cleanly, the job is marked failed with that message, the card
  keeps its version, Render again works); a browser without WebAssembly keeps the stop message.

### The options weighed

| Option | Size | Licence | Verdict |
| - | - | - | - |
| **FFmpeg's native `aac` encoder, our own wasm build** (above) | 0.63 MB (0.23 MB gzip) | LGPL-2.1-or-later (FFmpeg built without `--enable-gpl`, no external libraries) | **Chosen**: small enough to serve from the studio itself, no SharedArrayBuffer/COOP/COEP, no CDN, the encoder Instagram's own pipeline and most tools use, reproducible from a pinned release |
| `@ffmpeg/core` 0.12.10 (ffmpeg.wasm, single-thread) | ~31 MB wasm | **GPL-2.0-or-later** (built with x264/x265 etc.) | Rejected: GPL, too large for the Worker bundle (would need R2 or a CDN) and a full CLI for one encoder |
| libav.js 6.10.9 (`@libav.js/variant-*`, LGPL) | 2.3 MB (webcodecs variant) | LGPL-2.1 | Rejected: no published variant carries the AAC *encoder* (the author does not publish AAC builds; the `webcodecs` variant only parses AAC); building its `aac` variant is the same FFmpeg encoder with more glue |
| Fraunhofer FDK AAC in wasm | ~0.5–1 MB | FDK licence: not open-source by OSI/FSF terms, no patent licence, GPL-incompatible | Rejected: licence risk; better quality at low bit rates, which 128 kbit/s stereo does not need |
| A JavaScript AAC encoder | — | — | None maintained with acceptable quality; writing one is a large, risky project |
| Server-side encode | — | — | Not available (Workers cannot run an encoder; no render server) |

### Verified, and how

Google Chrome 156.0.8078.47, Linux, headless, `--no-sandbox`; real files,
inspected with ffprobe/ffmpeg 6.1.1.

- `node scripts/video-aac-fallback-check.mjs --chrome <chrome> --talk <clip> --out <dir>` builds the
  render-check harness, asks the editor's capability check (`audioEncoder: "wasm"`, the notice),
  renders four projects with the studio's codecs and inspects the files. The fixtures: a 640×360
  H.264 + AAC clip, black with one white frame and a 1 kHz beep of one frame's length at 1.0, 2.5,
  4.0 and 5.0 s (made with ffmpeg), the same beep as a WAV, and `01-talk.mp4` (Blender Foundation,
  CC BY, dialogue). Observed:

  | Check | Expected | Observed |
  | - | - | - |
  | Who encoded the sound | wasm (this Chrome has no AAC) | wasm, all four renders |
  | Video stream | h264 High yuv420p 1080×1920 | h264 High (level 4.0) yuv420p 1080×1920 |
  | Audio stream | aac LC 48 kHz 2 ch | aac LC 48000 Hz 2 ch; 127.3 kbit/s on the dialogue |
  | Box order | moov before mdat | ftyp moov mdat |
  | Sound edit list | one entry, media time 1024 | one entry, media time 1024, 6000 ms (30000 ms on the 30 s render) |
  | Start times (video / audio) | 0 / 0 | 0 / 0 |
  | Stream lengths | equal within one AAC frame (21.3 ms) | 6.0000 s / 6.0000 s (0.0 ms); 30.0000 / 30.0000 s on the 30 s render |
  | Clean decode (`ffmpeg -v error … -f null -`) | no errors | none |
  | Beep onset − flash in the source clip itself (reference) | 0 | +0.04 ms at each |
  | Beep onset − flash, the clip's own sound, 4 pairs | within ±33.3 ms (one frame) | +0.04 ms at each (the onset detector's two-sample step) |
  | The same, beep as WAV music, clip muted | within ±33.3 ms | +0.04 ms at each |
  | The same with the edit list ignored (`-ignore_editlist 1`) | (what the edit list removes) | +21.37 ms at each: the 1024 priming samples |
  | Drift: 30 s timeline (the sync clip five times), 20 pairs | within ±33.3 ms, first = last | +0.04 ms at all 20 (0–30 s): no drift |
  | Dialogue 1–7 s against the source's sound, cross-correlation (±50 ms) | peak at 0 | peak lag 0 samples, r = 0.9947 |
  | The wasm downloaded | once, only by the fallback | once (`/assets/aac-encoder-<hash>.wasm`) |
  | Encoder speed, 60 s of 48 kHz stereo | | 1.8–2.2 s (≈30× real time, two runs); the "Encoding audio…" step 0.4–0.9 s for 6 s of sound (the first one including the download and compile), 0.8 s for 30 s |

- `npx vitest run tests/aac-fallback.test.ts`: the ASC (built, FFmpeg's longer form, an escaped
  object type, an explicit rate, a short one refused); unit times over 3,000 units (64 s) land on
  their exact sample with no drift; unit counts with priming; `addEditList` on real `mp4-muxer`
  files: sizes add up, the edit sits after `tkhd` with the right values, `tkhd`/`mvhd` durations,
  and every video and audio sample read back by mp4box through the moved offsets is the one
  written (faststart and not), every AAC sample lasts 1024; refusals (second edit list, no track,
  bad media time); the real wasm in Node: 3 s of stereo → the expected unit count, times −1024,
  0, 1024…, raw blocks (a CPE first, FFmpeg's fill element in the first unit, no ADTS), 90–160
  kbit/s, two encoders independent.
- `PW_CHROMIUM=<chrome> node scripts/video-editor-smoke.mjs` now expects the fallback note (not the
  stop) where H.264 is present and AAC is not; `PW_CHROMIUM=<chrome> node scripts/video-core-smoke.mjs
  --studio-codecs` renders through the real studio UI with H.264 + AAC and records the Render
  panel's progress lines. Run in Chrome 156: the editor smoke saw `h264: true, aac: false`, no stop
  message and the note in the Render panel; the core smoke rendered through the real studio UI
  (mocked routes), the Render panel read "Encoding audio…", "Rendering the frames · n of N",
  "Finishing the file", the wasm was fetched once, and the uploaded file was h264 High + aac LC
  48 kHz stereo, 1080×1920, 3.0 s, both streams starting at 0, decoding cleanly; it went on the
  card. In the Playwright Chromium (no H.264): the stop message as before, no note, and
  `scripts/video-render-check.mjs` (VP9 + Opus) still OK.
- A blocked download of the encoder (the check routes the `.wasm` request to a network error): the
  render stopped with "The audio encoder could not be downloaded: check the connection and render
  again."; the next render in the same tab, download allowed, rendered (30 frames, AAC from the
  wasm).

### Not verified here

- Safari (any version) and iPhone: not available in this sandbox. Safari before 26 should take the
  fallback (it has `VideoEncoder`/`VideoDecoder` but no `AudioEncoder`); that the iPhone plays the
  result is expected (the same codecs, `moov` first, an edit list as in its own recordings) but was
  not tried on a device. The first render on a Mac in Safari and a play on an iPhone are still due.
- A browser with a native AAC encoder (Chrome/Edge on Windows or Mac, Safari 26): the native path
  was not changed, but it was not run here either (no such browser in the sandbox).
- Upload to Instagram.
- The Worker deploy with the larger embedded bundle (no deploy was made).

### Limits

- The fallback runs on the page's main thread in short slices: about 2 s per minute of sound on
  this machine, longer on a phone; the page stays responsive between slices.
- FFmpeg's native AAC encoder at 128 kbit/s: good for speech and music on social media (Instagram
  re-encodes anyway), below Apple's or FDK's encoder at low bit rates.
- 48 kHz stereo only (what the mix always is).
- The native path's own priming (Chrome's or Apple's encoder) is not corrected by an edit list;
  that is how it was before and was left alone.

### Decisions for the owner

1. **Hosting of the wasm**: it is served by the Worker with the app (no CDN, no R2). The embedded
   bundle grows by about 0.3 MB compressed; if a deploy hits the Worker size limit, move the file
   to R2 behind a same-origin route (one URL change in `aac-fallback.ts`).
2. **LGPL notice**: the encoder is FFmpeg (LGPL-2.1-or-later), loaded as a separate, replaceable
   file; its source is the FFmpeg 8.1.3 release plus `scripts/aac-wasm/`. Add FFmpeg to the app's
   credits/licences page with the LGPL text and where the source is, as the LGPL asks.
3. **AAC patents**: browsers' and Apple's encoders come with their makers' licences; this encoder
   ships with the studio. Most AAC-LC patents have expired, but whether an AAC licence (Via LA) is
   needed for distributing an encoder is a legal question we cannot answer here.
4. **Safari 26+ and Chrome/Edge on Windows/Mac** keep the native encoder; say if the fallback
   should be the one path everywhere (same sound everywhere, and the priming handled the same way).

## Edit quality: a sharable first cut, and "Edit like this video" (23 Oct 2026)

Branch `edit-quality` (from `qa-round` at `97dab86`). The owner asked whether Auto edit gives
sharable content or very weak edits, and for templates taken from a Pinterest video ("comparing the
two videos"). Nothing here calls a provider or spends anything; the reference video is analysed and
compared, never rendered into the output.

### Baseline: the auto edit as it was, judged as a social media editor would

Run on real footage (six clips cut from the Blender Foundation's open movies, CC BY: dialogue,
street, close-ups, Sintel, Big Buck Bunny, a phone clip with a 90° matrix) in Google Chrome, 15 s,
9:16, rendered and looked at frame by frame (`scripts/video-edit-quality-check.mjs --part baseline`).

**Verdict: weak edits, not sharable as they come out.** What it did well: it fills the length, it
is deterministic, the clips are trimmed and ordered, locks and speech flags are kept, and with music
the shot lengths are whole beats. What made it look weak:

- **It chose the worst moments on purpose.** "Motion energy" is the frame-to-frame difference, and
  nothing changes more than a cut or a dissolve inside the footage: 6 of 10 shots (Promo/Balanced)
  and 7 of 12 (Launch/Energetic with music) straddle a cut or a dissolve of their own clip, so one
  2.5 s "shot" shows three scenes and flashes between them.
- **Dark, blank and title-card footage.** A fade to black in Sintel and the white "THREE RODENTS"
  card of Big Buck Bunny count as movement too: 2 of 10 and 3 of 12 shots are black, near-black or
  a title card; one cut ends on the title card cropped to "EE RODE".
- **No structure.** It opens on whatever moves most (a dark dissolve), has no build or payoff,
  and no end card: the launch "ending" dips to black into a random shot. No room for a logo or a call
  to action, no words at all.
- **Repetition.** The same dissolve appears twice; the same seconds come back with nothing to tell
  them apart.
- **Framing.** Wide footage (2.39:1) is centre-cropped into 9:16 whatever is in it, the same zoom on
  every shot.
- **Rhythm.** With music, the "beats" of a busy track are its eighth notes (0.25 s), so cuts land on
  any eighth, not on the beat or the bar; cuts fall mid-gesture.

Contact sheets: `baseline-*-shots.jpg` (first, middle and last frame of every shot) and
`baseline-*-every-half-second.jpg`, in the session's scratchpad `edit-quality/final/`.

### What changed

**Reading the footage** (`shared/shot-analysis.ts`, pure; `src/video-editor/engine/analyse.ts`
decodes): each source is decoded with WebCodecs in order (the export's own reader), ten frames a
second, each drawn upright at about 160 px wide and measured: brightness, contrast, clipped
shadows/highlights, **focus** (variance of the Laplacian in the sharpest and the median tile of a
4×3 grid), a 4×4×4 colour histogram, a 64-bit difference hash, where the detail sits
horizontally, a rough text band; between frames the change, the camera's shift (row/column profiles,
refined below a pixel), a zoom hint (after taking the shift off) and what moves beyond the camera.
From those: **the footage's own cuts** (an adaptive threshold: a local peak of the histogram change
well above the median of the frames around it, with the grey difference and the hash as second
votes, so a cut between two dark shots is found and a handheld shot does not cut itself) and
**dissolves** (twin comparison), then **half-second windows** scored for quality (sharp, exposed,
steady, not blank) and action, flagged dark, blown out/white, flat, blurry, shaky, across a cut or a
fade. Measured on the six clips: 1.4–3.3 s per 6–8 s clip in Chrome; the cuts it found match
ffmpeg's scene detection on the same files (05-bbb: 1.2, 3.2, 3.9, 5.0, 6.0, 6.6 s both; 01-talk:
1.7 / 3.7 against 1.67 / 3.67, and the 4.4–6.7 s dissolve as one fade).

**The plan** (`shared/edit-plan.ts`, `planEdit`, pure and deterministic):
- **Structure**: hook (the sharpest, liveliest good moment, short) → build (sources alternate, more
  movement toward the end, lengths varying around the pace: never the same twice in a row) →
  payoff → **end card** (a calm, clean shot held 2.2–3.4 s with a slow push in, the call to action
  and the client's logo when the brand kit has one, else room for it).
- **Never** across the footage's own cuts or fades (0.12 s kept from them); dark, blank, blown-out,
  blurry or shaky half seconds only when nothing else is left; near-duplicates (hash within 10 bits)
  not shown twice; footage with words burned in and the same footage again count against a shot.
- **Cuts on still moments**: within the stretch a shot may take, its in and out go where the
  picture moves least (not mid-gesture).
- **Music**: the beat grid is grouped into a pulse and bars (`shared/music-bars.ts`: a grid faster
  than 0.36 s is halved to its louder half; the downbeat is the loudest of four phases); cuts land on
  the pulse, the section changes (out of the hook, into the end card) on a bar when one is within a
  pulse and a half, and the cut ends on a bar. A track without a steady beat (speech, ambience) is
  not cut to.
- **Framing**: wide footage in a tall frame is panned toward its detail; footage used again is
  punched in (1.2–1.35×) so it reads as another angle; long calm shots push in slowly. Dark shots get
  up to half a stop (the clip's exposure, visible under Colour).
- **Optional, off by default**: calm shots a little faster (1.25×). Restrained on purpose; there is
  no per-shot speed curve in the document, so it is a constant speed, not a ramp.
- **Text**: placeholder words from the purpose over the hook and on the end card (Launch "NEW" /
  "Available now", Promo "LIMITED OFFER" / "Shop now", Story "Our story" / "Brand name"), in Arabic +
  English, English or Arabic; words the person already wrote are kept and nothing is added.
- **Look**: the purpose's preset at 50–60 % when the cut has none (Cool Editorial, Bold Sport, Warm
  Film).
- **Frame**: a 9:16 Reel by default, or "Keep W×H".
- Locked clips stay exactly on their second; clips marked "has speech" come back whole (phase 2's
  rules, kept).
- **The panel says what it did** ("What the auto edit did", kept with the draft), e.g.:
  "Hook: 02-street at 0:01.4, 1.0 s (the sharpest, liveliest moment found)." · "13 shots of
  0.5–2.0 s, 15.0 s in all; cuts on the beat (12 of 12), 4 on the bar, 120 BPM." · "Ends on 02-street
  held 2.0 s with a slow push in, room for the logo (add it under Logo) and the call to action." ·
  "Left out (half seconds): 7 dark, 8 blank or blown-out, 1 shaky, 15 across a cut or fade in the
  footage." · "3 reused shots are punched in so they read as new angles." · "Text: “NEW” over the
  hook and “Available now” on the end card: placeholders to replace."

`planFirstCut` (phase 2) and `planAutoEdit` (phase 1) stay in the code with their tests; the panel
uses `planEdit`.

**"Edit like this video"** (Auto edit tab, below the first cut; the Templates gallery points to it):
- **Where the reference comes from**: a **Pinterest** pin link (`POST
  /api/studio/posts/video/editor/reference`, admins, editor switch, ledger `editor.reference` at
  estimate 0, `server/video-reference.ts`, behind the Pinterest switch too): the pin id from the
  link (any pinterest.* country site; a pin.it link's redirect read from pin.it only). **When
  Pinterest is connected** (Connection → Pinterest, `server/pinterest.ts`: an access token, and
  ideally the app id, app secret and refresh token so the 30-day token renews itself, or "Sign in
  with Pinterest"), the pin is read with Pinterest's official API (`GET /v5/pins/{id}`, scopes
  boards:read + pins:read) and its first video taken from `media` (`video_url` of a video pin, or
  the first video item of a multi-item pin); refusals are plain: "Pin not found or private" (the
  API reads only pins on the connected account's boards: save the pin there first), "This pin is a
  picture, not a video", or a video whose link Pinterest withheld. **Not connected**, the old
  reading stays as a fallback: MP4 renditions from Pinterest's pin endpoint, else the pin page
  (720p preferred, never the HLS playlist), with "Connect Pinterest in Connection for reliable
  links." after any refusal. Either way the bytes are taken only from Pinterest's video host (`https://v*.pinimg.com/videos/…mp4`), an
  MP4 by its `ftyp` box, 60 MB at most, copied to R2 under `editor-refs/` with a 7-day expiry
  (`GET …/reference/:id` serves it with Range to whoever may see the month; 410 and deleted once
  expired; expired copies are swept on each fetch). When Pinterest refuses: "Pinterest did not hand
  this pin's video to the studio (it often refuses servers). Save the video from Pinterest and use
  Upload, or pick the clip from the client's Drive: the analysis is the same." A **Drive** video of
  the client (read only, the same route). A file from **this computer** (stays in the tab).
- **The analysis** (in the tab, every frame): shots (cuts and dissolves as above), each shot's
  length, action and camera move (still, pan, push in, pull out, handheld), the pace (cuts per
  second every 2 s), its colour (Lab mean and spread), its music's tempo and bars when it has a
  steady beat, a rough on-screen text guess (or "not detected").
- **The template** (`shared/reference-template.ts`, same shape as `VideoTemplate`): one slot per shot
  at its exact length, push/pull as a slow zoom, a placeholder text layer where text was seen, the
  logo on the last shot. **Apply to my footage** maps the person's footage onto its slots by
  movement rank (the busiest reference shots get the liveliest footage, quality first, never across
  the footage's cuts, no near-duplicates; `fillSlots`), optionally **matches its colour** (a Lab
  match at 80 % per clip, the existing colour match, reference kind "video"), a Reel when the
  reference is vertical. Everything stays editable; undo brings the previous cut back.
- **Compare the two videos**: a full-screen view with the reference and the cut side by side
  (the cut drawn by the editor's own compositor on its own canvas, so it is what renders; the
  editor's preview is held meanwhile), played together (the reference follows the cut's clock:
  nudged ±8 % when within 0.25 s, re-seeked beyond), a scrubber, sound from either, and the
  **shot-by-shot table**: where each shot starts and how long it lasts in both, and the difference
  in frames. "The reference is shown here only to compare; it is never part of your video."
- **Stored** with the draft: `project.reference` (the analysis, about 1.4 KB for 12 shots; never the
  pictures) and `project.edit` (the summary). A reopened draft shows the facts, the table, and plays
  the reference from the studio's copy while it is kept, else asks to fetch or pick it again.

**Schema**: `PROJECT_VERSION` 3 → **4**; `migrateV3` adds `edit: null, reference: null`, chained
1 → 2 → 3 → 4, so every older draft draws and sounds the same. `validateProject` checks both (the
reference's shots, pace, colour, music, at most 200 shots and 3 minutes). Colour match references
gain the kind `video`.

**Compositor**: `frameAt` treats a cut that floating-point sums put a microsecond after a frame time
as on that frame (`CUT_EPSILON`, 1 µs). Preview and render both use `frameAt`, so they stay equal;
before, 0.1 + 0.2-style sums could put a cut one frame late. `Player` gained `suspend`/`resume`
(the comparison holds the main preview). `checkCapabilities` asks for Opus instead of AAC when the
automated check asks for H.264 + Opus (the studio's renders are unchanged: H.264 + AAC).

### Verified, and how

- **Unit tests** (`tests/edit-quality.test.ts`, 37): focus on sharp vs blurred, the hash under grain
  and on other pictures, histograms, the camera's shift and push/pull, where the detail is, a text
  band and none on plain/natural pictures; **shot boundaries on synthetic sequences** (three cuts
  found to the frame including a same-colours cut, none inside a handheld shot; a dissolve read as a
  fade, not cuts; the same answer from linked frames whose grey copies were dropped); window flags
  (dark, flat, blurry, shaky, across a cut) and action; **pulse and bars** (an eighth grid halved to
  its louder half, the downbeat phase and confidence, accents, steady beat vs speech-like sound);
  the **cut plan** (hook/build/payoff/end filling the stretch exactly, lengths varying, cuts on the
  pulse and sections on bars for all three paces, speech whole after the hook); **planEdit** (exact
  length, hook on the liveliest good moment, a calm end card with its push in, never across the
  footage's cuts or into dark/blank seconds, reuse only punched in, sources alternate, placeholder
  words and the summary, validation and determinism, cuts on the pulse with music, crossfades
  centred on the planned cuts, punch-ins when footage is short, **locked clips exactly in place and
  speech whole**, unreadable footage, panning, runs); `withEditPlan` (the person's words kept, the
  preset only when none, the frame, the summary); the **reference** (12-frame-accurate shots of a
  0.6/1.2 s synthetic rhythm, the push read, the template with the same lengths and a text layer,
  the mapping by action, the comparison within a frame, the 24-clip note, storage and checks, the
  3 → 4 migration). `tests/video-reference.test.ts` (12, Pinterest mocked, no network): pin ids,
  renditions in escaped JSON and HTML (720p first, never the playlist or another host), the MP4 and
  size checks, the 720p download from the video host only, pin.it and the page fallback, the plain
  refusal and no-video messages, member 403 with nothing written, the admin copy with its expiry and
  a ledger row at 0, Range 206, 410 once expired, a Drive file outside the client refused, the switch
  off (503, no network), the sweep. Existing version assertions moved to 4.
- **Gate chain** green: `npm run typecheck && npx eslint . && npx vitest run && npm run build`
  (117 files, 1037 tests).
- **Real renders in Google Chrome** (`node scripts/video-edit-quality-check.mjs --footage <clips>
  --chrome <chrome> --out <dir>`): H.264 (Chrome's encoder, `avc1.64002A`) + Opus in MP4, since
  Chrome has no AAC encoder. Before and after on the same six clips, 15 s, 9:16:

| | Baseline Promo/Balanced | After Promo/Balanced | Baseline Launch/Energetic + music | After Launch/Energetic + music |
| - | - | - | - | - |
| Encoded (ffprobe) | 1080×1920, 14.98 s | 1080×1920, 15.02 s | 1080×1920, 15.06 s | 1080×1920, 15.04 s |
| Shots | 10 (1.2–2.5 s) | 8 (1.4–2.6 s) | 12 (0.8–2.6 s) | 13 (0.5–2.0 s) |
| Shots across a cut/dissolve of their own footage | 6 | **0** | 7 | **0** |
| Shots with dark, blank or title-card seconds | 2 | **0** | 3 | **0** |
| Same seconds shown again | 1 (as is) | 3 (punched in) | 2 (as is) | **0** |
| Hook / end card / words | none / none / none | 02-street / 02-street held 2.6 s / 2 placeholders | none / dip to a random shot / none | 02-street / 02-street held 2.0 s / 2 placeholders |
| Cuts on the beat / bar | (no music) | (no music) | on the 0.25 s grid | 12 of 12 on the beat, 4 on the bar, 120 BPM |
| Render time (headless, software H.264) | 236 s | 191 s | 304 s | 212 s |

  Frame strips (first, middle, last frame of every shot) and every-half-second sheets were looked
  at: `final/baseline-*-shots.jpg`, `final/after-*-shots.jpg`.
- **"Edit like this video" end to end**: a reference cut here from Tears of Steel (CC BY): 12 shots
  alternating 0.6 s / 1.2 s on a 100 BPM track, cropped to 9:16 720×1280, the third pushing in,
  "NEW DROP" on the second and fifth (`final/reference.mp4`). Read in Chrome frame by frame in 4.8 s:

| Check | Ground truth | Observed |
| - | - | - |
| Shots found | 12 | 12 |
| Shot starts, error in frames | 0 at 0, 0.6, 1.8, 2.4 … 9.6 s | 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0 |
| Shot lengths | 0.6 / 1.2 alternating | 0.6 / 1.2 alternating |
| The push in (shot 3) | push | push |
| Tempo | 100 BPM | 100 BPM (a steady beat) |
| Text | shots 2 and 5 | shot 5 at y 0.754 (shot 2, white words on a busy neon picture, missed) |
| Our cut vs the reference, table | within a frame | 0 frames on all 12 rows |
| The rendered cut's cuts (ffmpeg scene detection) vs the reference's | 0.6, 1.8 … 9.6 s | 0.60, 1.80, 2.40, 3.60, 4.20, 5.40, 6.00, 7.20, 7.80, 9.00, 9.60: 0 frames |
| Stored analysis | not the footage | 1,386 characters in the draft |

  (Before the template's in and out points were kept to the microsecond and `frameAt` got its 1 µs
  tolerance, the rendered cuts were one frame late on 9 of 11.)
  `final/reference-vs-ours.jpg`: the reference's shots over ours, middle frames.
- **The real UI** (`npm run build && node scripts/video-edit-quality-smoke.mjs --footage <clips>
  --reference <mp4> --chrome <chrome> --out <dir>`, the built app with a stateful mock, the six clips
  as the post's versions): Build the cut → 8 shots and the summary; a Pinterest link the mock refuses
  shows the plain message naming Upload and Drive; the uploaded reference is read ("12 shots, average
  0.90 s (0.60–1.20 s)", "Music: a steady beat at about 100 BPM", text "seen on 1 shot"); Apply → 12
  shots; Compare → 12 table rows, all "0 fr"; playing both, the reference's drift from the cut's clock
  stayed within 0.042 s (sampled every 250 ms on an idle machine); paused, both on the same frame;
  Save draft → version 4 with the reference (12 shots, 1.4 KB) and the summary; after a reload and
  reopen the summary, the facts and the 12-row table are back and the comparison asks to "Pick it
  again" (an upload stays in its tab); at 390 px neither the comparison nor the Auto edit panel
  scrolls sideways. Screenshots looked at: `ui/ui-compare-1440.png`, `ui/ui-compare-390.png`,
  `ui/ui-compare-390-table.png`, `ui/ui-reference-panel-1440.png`, `ui/ui-auto-edit-1440.png`,
  `ui/ui-auto-edit-390.png`, `ui/ui-compare-after-reload-1440.png`.

### Not verified

- **Pinterest live**: Pinterest's video host answered 403 from this sandbox; the fetch is verified
  with mocked responses only (shapes as Pinterest's pin endpoint returns them, values made up). The
  first live test is on the preview deployment: a public video pin link → the facts appear; a refusal
  → the plain message. Story pins (several pages) are not specially handled.
- The Drive reference route's success path (the demo Drive has no clip bytes); only the refusal of
  a file outside the client's folders is tested.
- AAC: Chrome here has no AAC encoder, so renders were H.264 + Opus; the studio's H.264 + AAC path
  is unchanged.
- The comparison's sync under heavy load: with a render running in another Chrome on the same
  machine the reference fell 0.2–0.3 s behind (its decoder could not keep up); idle, within 0.042 s.
- Real clients' footage (products, food, people talking): the thresholds were tuned on the
  Blender open movies.

### Limits

- Heuristics, not understanding: nothing recognises faces, products or words. "Strongest shot" is
  sharp + exposed + steady + moving; on this footage the hook was a street shot with a soft pole
  passing in front, which a person might not pick. A shot with words burned in is avoided but not
  excluded (one came through in the music cut).
- Speech is still a flag the person sets ("Has speech"); the dialogue clip's talking was not
  detected as speech.
- The text guess is rough (rows of short, sharp strokes): thin or low-contrast words on a busy
  picture are missed, stripes can read as text.
- Camera moves are hints from small frames: film footage with slow drifts reads push/pull/pan more
  often than an editor would say.
- A reference above 24 shots or 60 s fills the first 24 / 60 s (said); above 3 minutes is refused.
- "Speed up calm shots" is a constant 1.25× per shot, not a ramp within a shot.
- Reading footage costs about a quarter of its length in Chrome on a laptop-class CPU (once per
  source per tab); a reference about half its length (every frame).
- R2 has no per-object expiry without a bucket rule: expired copies are refused on read and swept
  (up to 50) on each new fetch.

### Decisions for the owner

1. **Pinterest**: the studio copies a pin's video to its storage for 7 days for analysis only. Keep
   7 days, shorten it, or prefer "save the video and upload" only?
2. **Placeholders**: the auto edit writes "LIMITED OFFER"/"Shop now" and the like by default.
   Keep them on by default, or start from the post's headline and caption when there is one?
3. **9:16 by default** for the auto edit (as for templates), with "Keep W×H". Confirm.
4. **An optional AI step** (not built): a provider's video reading (e.g. Higgsfield's check) could
   pick the hook by content or detect speech; it would be admin-only, off by default and priced
   before use. Say if it is wanted.

## Architecture

**Where rendering happens.** A Cloudflare Worker cannot decode, render or mux video: there is no
ffmpeg, no native codecs, a CPU-time limit per request and a memory limit well under one clip.
A server render elsewhere (a VM, a render service) is not part of this product. So the browser
renders, with the codecs the person's machine already has.

**The choice: WebCodecs + pure-JS demux/mux.** Three ways were weighed:

| Way | What it needs | Verdict |
| - | - | - |
| **WebCodecs** (`VideoDecoder`, `VideoEncoder`, `AudioEncoder`) with `mp4box.js` to read the mp4 and `mp4-muxer` to write it | A browser with hardware H.264/AAC: Chrome, Edge (all platforms), Safari 16.4+ on Mac and iPhone | **Chosen.** Real-time or faster on a laptop, ~160 KB of JavaScript, no special headers, the exact codecs the output needs |
| `ffmpeg.wasm` | A 30 MB download per session, `SharedArrayBuffer` (so COOP/COEP headers on the studio and every embedded resource), software x264 at well under real time, no GPU | Rejected: too slow and too heavy for a 60 s reel, and the headers would break the share pages and signed links (only FFmpeg's AAC encoder is used, as a 0.6 MB WebAssembly file, where the browser has no AAC encoder: see "AAC without WebCodecs") |
| A server render | A machine with ffmpeg | Not available |

The two packages, pinned exactly:

- `mp4box` 2.4.1 (BSD-3-Clause, GPAC; the TypeScript rewrite, ~90 KB minified): reads the file's
  boxes, hands out the H.264 samples with their timestamps and the `avcC` record the decoder needs.
- `mp4-muxer` 5.2.2 (MIT, Vanilacode; ~70 KB): writes the mp4 with `fastStart: "in-memory"`, so
  `moov` sits before `mdat` and iPhone plays from the first byte.

Both are published, widely used, and do one thing each; no other new dependency.

**Browser support.** H.264 decode and encode through WebCodecs: Chrome and Edge on Windows, Mac,
Linux (hardware where present, software otherwise), Safari 16.4+ on Mac and iPhone (hardware).
AAC encode: Chrome and Edge on Windows and Mac, Safari 26+; **not** Google Chrome on Linux (measured,
Chrome 156) nor Safari before 26, where the editor's own WebAssembly AAC encoder takes over
("AAC without WebCodecs" above). Open-source Chromium builds (the Playwright one here included)
carry **no H.264 and no AAC** at all; Firefox has no `VideoEncoder` for H.264. The editor asks up
front (`VideoEncoder.isConfigSupported` for `avc1.64002A` / `avc1.640028`, `AudioEncoder` for
`mp4a.40.2`, `VideoDecoder` for H.264) and, when H.264 is missing, shows "This browser cannot
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
the project's `look` (a named parameter set) and since phase 3 its `lookAmount`, `colour`,
`protectSkin`, `lut` (name, size, strength and, since phase 3, the table as `data`), `music` (an
upload, one of the post's tracks by `audioKey`, or since phase 3 a music library track, `catalog`
or `library`, with its rights), `offset`, `volume`, fades, the detected `beats`), `output` (width, height, fps, bitrate),
`snapToBeats`, `rev`, `createdAt`, `updatedAt`. Stored in `video_projects` (migration 0072) with
`source_video` (the version it opened from) and `rendered_video` (the version the last export
made).

**The render pipeline**, step by step (`src/video-editor/engine/export.ts`):

1. Capability check; stop with the message when H.264 is missing; AAC from WebCodecs, or from the
   editor's WebAssembly encoder when WebCodecs has none.
2. Each clip's bytes (the Range route for a version, the File for an upload) demuxed once with
   mp4box; its sound decoded with `decodeAudioData` when no music is set.
3. The sound rendered in an `OfflineAudioContext` (music with its offset, volume and fades, or
   the clips' own sound trimmed, sped and crossfaded like the pictures), then encoded with
   `AudioEncoder` into the muxer (or with the WebAssembly AAC encoder, whose priming an edit list
   removes after `finalize()`).
4. For each output frame time t: `frameAt` (shared) says which clip is on screen, at which source
   time, and the mix during a crossfade; a `FrameCursor` per clip hands out the decoded
   `VideoFrame` at that source time (sequential decode; reopened at the key frame before t only
   when going backwards); the grader draws one or two frames with the colour and LUT; a
   `VideoFrame` of the canvas goes to `VideoEncoder` (key frame every two seconds); the muxer
   takes the chunk.
5. Flush, `finalize()`, a Blob; then `POST /render` stores it as a version (or, with no post, the
   file is saved).

**What is not possible**, and is said so in the UI: no server-side render; no Instagram music
library (a track comes from the person's computer or the studio, and they must hold its rights;
Instagram's own music can only be added in the Instagram app when posting); no other codec path
when the browser lacks H.264 (a missing AAC encoder is covered by the WebAssembly fallback); no editing of the words baked into a clip (that is
the Text Studio's job, before the clip is made); a track picked from this computer in the
standalone editor is not kept (a post's tracks and library tracks are, and since phase 3 the LUT
table is too).

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
- AAC fallback: `src/video-editor/engine/aac-fallback.ts` (lazy), `aac-encoder.wasm`,
  `shared/aac-wasm.ts`, `shared/aac-mp4.ts`, `scripts/aac-wasm/` (build), `tests/aac-fallback.test.ts`,
  `scripts/video-aac-fallback-check.mjs` (see "AAC without WebCodecs").
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
  (split), Delete (ripple) / ⇧Delete (leave a gap), L (lock), ←/→ (a frame, ⇧ a second), ↑/↓
  (previous / next cut), Esc.
- Phase 2 files: `shared/video-timeline.ts` (timecode, zoom, snapping, selection, reorder,
  split, delete, beat alignment), `shared/video-keyframes.ts`, `shared/video-mix.ts` (clip levels,
  music span, fades, ducking, the gain curve), `shared/video-autoedit.ts` (`planFirstCut`),
  `shared/video-history.ts`, `shared/video-drafts.ts` (autosave rules); `ui/Timeline.tsx` +
  `ui/timeline.css`, `ui/KeyframeControls.tsx`, `ui/MusicMix.tsx` (music mix controls, Voice-over
  panel), `ui/AutoEditPanel.tsx`, `ui/autosave.ts`; `scripts/video-phase2-check.mjs`.
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
everything afterwards; undo restores the previous timeline. Phase 2 replaced the panel's planner
with `planFirstCut` (purpose, pace, locked clips, protected speech; see "Phase 2" above);
`planAutoEdit` stays in `shared/video-project.ts` with its tests. Since *Edit quality* (above) the
panel uses `planEdit` (shared/edit-plan.ts): footage read for quality and its own cuts, a hook,
build, payoff and end card, bars, placeholder words and a summary.

### Music sync

The track's RMS envelope (20 ms hops) feeds `detectBeats`: an onset is a hop above 1.3× the mean of
the second before it, at least 0.25 s after the last; the most common onset spacing (to 20 ms)
becomes the grid period and a grid is laid from the first onset, drifting to the nearest onset
where one exists so quiet bars still get a tick. Since *Edit quality* the auto edit groups the grid into a pulse and bars (`shared/music-bars.ts`).
Limits: the detector itself finds pulses, not downbeats or bars;
rubato, very quiet or very dense tracks give a rough grid. The beats show as ticks on the ruler;
"Snap cuts to beats" moved each cut to the nearest beat within 0.25 s by trimming the clip that
ends there (its out point; speed honoured). Phase 2 replaced the button with "Align cuts to
beats" (a roll edit that keeps the total length and leaves locked clips and speech alone);
`snapCutsToBeats` remains (now skipping locked and speech clips) and `snapToBeats` stays in the
document but has no button.

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
  checks that the editor mounts, that the stop message appears exactly when H.264 is missing (AAC alone missing: the fallback note instead, since 23 Oct 2026)
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

- **The native AAC encoder**: the Playwright Chromium has neither H.264 nor AAC, so the pipeline was
  first run end to end with VP9 + Opus (above). Since 23 Oct 2026 H.264 encode/decode was run for
  real in Google Chrome 156 on Linux with the WebAssembly AAC encoder (see "AAC without
  WebCodecs": h264 High, aac LC 48 kHz, moov first, A/V sync measured); a browser with a *native*
  WebCodecs AAC encoder (Chrome/Edge on Windows or Mac, Safari 26) was still not available. The
  first run there should render a post, check the new version's warnings line (nothing about AAC
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
- Since phase 2 the clips' own sound is mixed with the music (per-clip volume and mute; the music
  ducks under speech and the voice-over). A draft saved before phase 2 with music opens with its
  clips muted, so it sounds as it did; unmute them under Media to mix.
- Framing is Fill or Fit with zoom and pan per clip, keyframable since phase 2; Fit shows a plain
  background colour (no blurred copy yet).
- The preview uses the browser's `<video>` decoding at up to 540×960; the render uses WebCodecs at
  full size. The compositor (framing, colour, text, logo) is the same for both.
- The LUT is applied after the sliders and to the whole cut (not per clip); since phase 3 its table
  is stored with the draft at 33³ at most. Per-clip colour is sliders, a preset with its intensity
  and a colour match (phase 3).
- Transitions: cut, crossfade, dip to black, dip to white. Text layers are words (one language or
  two lines, Arabic and English) with a font family, weight, colour, box, position, opacity and
  keyframed position / scale / opacity. Logos are one picture each (a brand-kit address or a small
  file of 200 KB at most), with keyframed position / scale / opacity.
- See "Limits (phase 2)" above for the timeline's own limits.
- A render runs in its tab; closing the tab interrupts it (the job says so; Render again).

## iPhone and Instagram

The output is what both want: H.264 High 4.0/4.2 `yuv420p`, AAC-LC 48 kHz stereo, `moov` first,
1080×1920 / 1080×1080 / 1080×1350 at 30 fps, 4–12 Mbit/s, under 60 s. Instagram re-encodes on
upload; a higher bit rate does not survive it, so "Good · 8 Mbit/s" is the sensible default. The
file is served by the studio's Range route like every version and plays inline on the approval
page once selected for the client.
