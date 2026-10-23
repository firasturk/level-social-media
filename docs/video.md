# Video versions of a post (Higgsfield image-to-video)

A finished post becomes a short clip: the picture (or the composed artwork, words and logo drawn
in) is the first frame, the motion idea is the prompt. Every clip is a *version* of the post, kept
with it; the first finished clip is the one the client sees on the approval link until the team
picks another or shows the picture instead. Every clip is a **Reel 9:16** by default (Portrait 4:5,
Square 1:1 and Landscape 16:9 on request; docs/video-studio.md "Frame"). Nothing is drawn over a
clip after generation.

## What is live and what is mocked

| Piece | State |
| - | - |
| Model catalog (`shared/video-models.ts`) | Built from the Higgsfield docs (below); every price is `null` because the docs give none |
| Submission, status polling, download into R2 | Written against the documented API; exercised only against a fetch stub in `tests/video.test.ts`. No paid call was made |
| Provider estimate (`POST /estimate/<slug>`) | Called before each submission; mocked in tests. Not verified live |
| Governance (`server/integrations.ts`) | The real layer on `int-round`: admins only, the Higgsfield switch, ledger rows (`kind: video`), claims in D1. The estimate order on the **Cloud API** path is: catalog price → per-engine price (Connection → Higgsfield) → the admin's one figure under Admin → Integrations → the provider's `/estimate` call; none known → 409 `needsEstimate` until confirmed. On the **subscription credits** path (the Higgsfield sign-in, docs/higgsfield-mcp.md) the order is one step: `generate_video` with `get_cost: true` gives the credits of exactly this clip (nothing submitted); the admin confirms the credits shown; no figure → 409 `needsEstimate` until confirmed. `tests/video.test.ts` mocks the layer to observe the calls; `tests/integrations.test.ts` runs the real one |
| Billing choice (`server/higgsfield-billing.ts`) | Setting `higgsfield_billing`: `credits` (the Higgsfield sign-in and the MCP adapter, `server/higgsfield-mcp.ts`, versions with `provider = 'higgsfield-mcp'`) or `cloud` (this path). With `credits` chosen `POST /` and `/retry` answer 409 "Videos are set to use the subscription credits…"; `GET /list` carries `billing`. Default: credits once a sign-in exists, else cloud. `tests/higgsfield-mcp.test.ts` |
| Range/HEAD serving, upload, share route, review versions | Real code, tested with the checked-in sample mp4 |
| Studio and client UI | Built; walked on the preview with an uploaded sample clip (card badge, inline player, dialog, Versions group, client page on desktop and a 390 px phone viewport). Headless Chromium has no H.264 decoder, so decoding itself was not observed; the Range/HEAD/416 answers were |

## Routes

Studio, under `/api/studio/posts/video` (`server/video.ts`, mounted from `server/studio.ts`):

- `POST /api/studio/posts/video` — `{batch, index, model, prompt, duration?, aspect?, resolution?, audio?, source: "picture"|"artwork", artwork?: dataURL, frame?: "9:16"|"4:5"|"1:1"|"16:9", fill?: "crop"|"blur", words?: boolean, confirm?}` (the same `frame`, `fill`, `words` on `/api/studio/higgsfield/mcp/generate` and `/api/studio/video/magnific/generate`; an unknown frame or fill is 400). `frame` is the frame asked for; `fill` says the browser composed the picture to it (`source: "artwork"` then carries the composed picture); `words` says whether the words and logo are in it. Admins only (`requireIntegrationAdmin(c, "higgsfield")` + `assertIntegrationEnabled`). The cost is settled first: the catalog price, else the admin's `video_price_<slug>` setting, else the provider's estimate; with none of them the route answers 409 `{needsEstimate: true, model}` until `confirm: true`. `claimSubmission` on `video:<batch>:<post>:<sha256 of model+prompt+settings+source+poster>` refuses the same ask within ten minutes. `recordIntegrationOp` gets the estimate; the request id goes to `updateIntegrationOp`. The submission carries an `Idempotency-Key` (the clip's id). A provider rejection is kept as a `failed` version with its message; nothing retries by itself.
- `POST /api/studio/posts/video/retry` — `{batch, id, confirm?}`: a failed clip submitted again as a new job and a new op.
- `GET /api/studio/posts/video/list?batch=&index=` — the post's clips, newest first, with `engines`, `prices` and `admin`; each item carries `frame`, `frameFill`, `words` beside `aspect`. In-flight clips (`queued`, `generating`) are asked about here (six per call at most): a finished one is downloaded into R2 and marked `done` — and marked for the client when the post has no client version yet (`autoSelectForClient`) — a failed one keeps the provider's message, one older than thirty minutes is given up. This is how a refreshed studio reconnects to a running job; the dialog and the cards poll it. The cron never submits or polls.
- `GET /api/studio/posts/video/summary?batch=` — one line per post: the client's version, the newest finished clip, the newest clip of all, and `card`: the done version with the highest `card_rank` (migration 0076: an editor render's start time, or the time of an explicit choice), which the card plays first.
- `POST /api/studio/posts/video/select` — `{batch, index, id|null}`: the version the client sees (`for_client`, at most one per post). The first finished clip of a post is marked by itself; this route changes the choice or clears it ("Show the picture instead"); a later clip never replaces a chosen one. A choice also becomes the card's version (`card_rank` = now), so a render that started earlier never replaces it.
- `POST /api/studio/posts/video/upload` — multipart `batch`, `index`, `file` (mp4, 60 MB at most), `note`. Admins only. Stored as a `done` version with `provider = 'upload'`, `source = 'upload'` through `storeVideoFile` (the checks shared with the video editor's export), the client's version when the post had none. The video editor also uses this route for the footage a person brings from their computer.
- `/api/studio/posts/video/editor/*` — the video editor's projects and its export, which becomes a `done` version with `provider = 'editor'`, `source = 'editor'` (`server/video-editor.ts`, docs/video-editor.md). Since the video core, "Render & update card" opens a render job (`video_renders`, migration 0076) and the upload promotes the render to the card and the client link unless the client approved the version they see or a newer render or choice is there (docs/video-editor.md → *Save draft, and Render & update card*). `POST /select` still selects any version ("Send for review").
- `GET|HEAD /api/studio/posts/video/file?batch=&id=` — the mp4 with Range.
- `GET|HEAD /api/studio/posts/video/preview?batch=&id=` — the lightweight preview (first 8 s, 360 px, no sound) with Range, when the browser made one; each version lists it as `preview` (else null: play `url`).
- `POST /api/studio/posts/video/preview` — multipart `batch`, `id`, `preview` (H.264 mp4, 6 MB at most) and/or `still` (JPEG/PNG/WebP, 1 MB at most): a rendition kept with a finished version after the fact (admins). Nothing is generated and no provider is called. `/upload` and the editor's `/render` take the same two optional fields.
- `GET /api/studio/posts/video/poster?batch=&id=` — the clip's own still when the browser kept one, else the still the clip started from.
- `GET /api/studio/engine/video-prices`, `POST /api/studio/engine/video-price {model, usd|null}` — the fallback prices (Connection → Higgsfield, admins write).

Client link (`server/share.ts`):

- `GET /api/share/:token` — each post carries `video: {id, url, poster, duration, version}` when a `for_client` finished clip exists (the first finished clip by itself, or the team's choice), and `version: {kind: "video"|"image", id, label}` for whatever is shown ("Video 2 (22 Oct)" or "Picture (22 Oct)"). Drafts are never listed. The page plays the clip on the post's card and shows its poster with a play mark on the feed cell.
- `GET|HEAD /api/share/:token/video/:index` — the selected clip with Range, behind the same token as the pictures; the provider's URL never leaves the server.
- `GET /api/share/:token/video/:index/poster`.
- `POST /api/share/:token/review` — now takes `version: {kind, id, label?}` and stores it on the reviewer's answer (`config.approvals[index].answers[].version`). Earlier answers on earlier versions stay; the studio's Approval view shows "on Video 1 (22 Oct)" next to each answer, and the client page says "you answered on … this one is newer" when the version moved on.

## Storage

Migration `0069_video_versions.sql` adds to `videos`: `provider` (`higgsfield` | `higgsfield-mcp` | `magnific` | `upload` | `editor`; the Video studio's preset runs and Higgsfield clip tools are `higgsfield-mcp` rows with a `model` of `preset:<id>` or `tool:<name>`, Magnific's clips and tools `magnific` rows, docs/video-studio.md), `settings` (JSON: duration, aspect, resolution, audio, estimate, estimateSource, credits, frame, frameFill, words, and for stored files faststart, codecs, width, height, warnings), `poster_key`, `source` (`picture` | `artwork` | `upload` | `editor`; `artwork` is any picture the browser composed: the words and logo drawn in, or the bare picture fitted to the frame — `settings.words` tells them apart), `for_client` (set by itself on the first finished clip of a post, changed under Versions), `op_id`. Status values: `queued` | `generating` | `done` | `failed`.

Keys: the mp4 at `<owner>/<batch>/video/<task>/<video id>.mp4`, its preview rendition beside it at `….preview.mp4` and its still at `….still.jpg` (`settings.previewKey`, `previewBytes`, `stillKey`); an artwork first frame at `<owner>/<batch>/video/<task>/<uuid>.artwork.(jpg|png|webp)`. For a `picture` clip the poster is the task's own output key (no copy).

## The model catalog and its source

`shared/video-models.ts` was written from the per-model pages of <https://docs.higgsfield.ai> on 22 Oct 2026 (`/docs/models/<family>/<workflow>.md`, "Input schema"), not from memory. Included: Seedance 2.5, Kling 3.0 Standard / Pro / Turbo, Kling 2.6 Pro, Kling 2.5 Turbo Standard, Hailuo 2.3 Standard, LTX-2.5 Fast, Wan 2.6, Wan 2.7 (image-to-video workflows). Each entry carries the duration options or range, the `aspect_ratio` and `resolution` values when the model has them, the prompt limit where the docs state one (Kling 3.0: 2,500 characters, truncated beyond; LTX-2.5: 2–5,000), and the field that turns generated sound off (`generate_audio` or `sound`). The two slugs that worked before (`bytedance/seedance-2.5/image-to-video`, `kling-video/v3.0/std/image-to-video`) are unchanged; `shared/qa.ts` re-exports the catalog so earlier imports still work.

Prices: the docs give none. "Billing and retention" says to call `POST https://api.higgsfield.ai/estimate/<slug>` with the same body (answer `{credits, usd}`) and that the estimate for the authenticated account is authoritative; failed and `nsfw` requests are not charged; outputs stay at least seven days, so the mp4 is downloaded into R2 as soon as it is done. The OpenAPI document at `/docs/openapi.json` lists only a handful of endpoints (Soul, Kling 2.5 Turbo, Hailuo 2.3 and the request routes) and no prices.

## Range and MIME verification

`server/range.ts` serves a stored object: `Accept-Ranges: bytes`, `Content-Type: video/mp4`, `Cache-Control: private, …`, `X-Content-Type-Options: nosniff`; HEAD answers the size; `Range: bytes=a-b`, `bytes=a-` and `bytes=-n` answer 206 with `Content-Range: bytes a-b/size` and the exact slice (read from R2 with `{range: {offset, length}}`); a range past the end answers 416 with `Content-Range: bytes */size`. Verified in `tests/video.test.ts` ("the stored file") against the sample: a 100-byte slice is byte-equal to the file's bytes 100–199, HEAD carries the full length, 416 on a bad range, and the share route answers the same way.

## iPhone notes

Safari on iPhone plays an inline `<video playsInline controls preload="metadata">` from an MP4 with **H.264 (AVC, baseline/main/high) video and AAC audio**, and it needs the server to answer **Range requests with 206** (it probes the file with a range first; a 200-only server shows a broken player). Playback before the whole file arrives needs the **`moov` atom in front of `mdat`** (faststart).

- What the provider delivers: the docs say only that the completed response carries `video.url` to an mp4; codec, audio and atom order are not stated. The studio reads the downloaded file's boxes (`server/mp4.ts`) and stores `codecs`, `faststart`, `width`, `height` in `settings` for each clip, so the first live clip will say what Higgsfield actually sends. Nothing is re-muxed here (no ffmpeg on the Worker).
- What the upload route checks: an `ftyp` box at the start (else 400), an `avc1`/`avc3` sample entry somewhere in `moov` (else 400 "must be H.264"); it notes a warning when the audio is not `mp4a` (AAC) or when `moov` sits after `mdat`. Duration comes from `mvhd`.
- The sample `tests/fixtures/sample-1s.mp4` (3 KB) was made with ffmpeg: a one-second 64×80 H.264 Constrained Baseline level 3.0 `yuv420p` clip with silent AAC audio and `-movflags +faststart`, checked with ffprobe. It plays on iPhone and is what the Range and upload tests use.

Command used:

```
ffmpeg -f lavfi -i "color=c=0x1a1a2e:s=64x80:d=1:r=24" -f lavfi -i "anullsrc=r=44100:cl=mono" -t 1 \
  -c:v libx264 -profile:v baseline -level 3.0 -pix_fmt yuv420p -c:a aac -b:a 32k -shortest \
  -movflags +faststart tests/fixtures/sample-1s.mp4
```

The client page plays each clip by itself while it is on screen, muted and inline, with the browser's controls and a sound button (the shared preview behaviour, docs/video-studio.md → *Autoplaying previews*); sound starts only when the viewer turns it on.

## Studio

- Card: the post's clip (the card's version — the last render or explicit choice — else the client's version, else the newest finished one; **Edit video** opens it in the editor) plays by itself over the picture while the card is on screen, muted and looping, with pause and sound buttons; it plays the lightweight preview when one was kept, else the full file. A "Video · 5s · Reel 9:16" badge says *the client sees this* when it is the client's, and switches the card back to the picture (and to the clip again); "Making the video…" and "Video failed · …" come from the newest clip.

## Autoplaying previews

Every clip (cards, versions, presets, dialogs, the version stage, the client link, the heroes) uses the one shared component, `src/components/AutoplayVideo.tsx`, with its rules in `shared/video-preview.ts`: visible clips play muted and inline, off-screen, background-tab, closed-dialog and covered clips pause, at most six play at once, a person's pause and playhead are never overridden, one clip is audible at a time, reduced motion keeps the poster with a Play button, and a refused or broken clip shows Play / Try again. The lightweight renditions (a still and an 8-second 360 px silent mp4 made in the browser; Workers cannot transcode) and exactly where they are and are not used are described in docs/video-studio.md → *Autoplaying previews*. `scripts/autoplay-smoke.mjs` checks all of it in Chromium at 1440×1000 and 390×844.
- Dialog ("Video from this picture"): the motion idea, the engine, length / resolution / sound as the model allows, the **Frame** control (Reel 9:16 by default; the picture is composed to the frame in the browser when the engine follows the picture), "Include the words and logo in the video input" (the browser composes the artwork and sends it as the first frame), the cost line, "Make the video", "Try again" on a failed clip, the versions list with "Select for client review" / "The client sees this". It reconnects to a running clip when opened.
- Editor → Versions: the picture (shown to the client when no clip is selected), each video version with its frame and state, "Select for client review" / "The client sees this" / "Show the picture instead".
- Approval view: each answer says which version it referred to.

## Audio

What each audio source can and cannot do is researched in [docs/audio-capabilities.md](audio-capabilities.md)
(Instagram's music library, Higgsfield, Magnific, the browser, the Worker). The short of it: the
Instagram music library can only be added in the Instagram app; Higgsfield's engines make their
own sound or none; generated music needs a Magnific key (none is connected); a licensed track can
be uploaded and kept with the version, and the browser-side Video editor mixes it in — the server
never changes the mp4.

The dialog's "Audio" block offers: **Engine sound** (only when the model's `audio` field says it
makes sound; `settings.audio: true`), **No sound** (`settings.audio: false`), **Upload a track**
(mp3, m4a, aac or wav, 25 MB at most, with a name and a licence line), **Generated music**
(disabled with the not-connected reason) and **Add music on Instagram when publishing** (a note).
Members see the block read-only ("Admins only for now"). The versions list and the dialog's
history show the choice per version: "Engine sound", "No sound", "Track: name", "Music added on
Instagram". The client link is unchanged: it plays the stored file as it is.

Routes under `/api/studio/posts/video/audio` (`server/video-audio.ts`, provider `audio` in
`server/integrations.ts` with its own switch under Admin → Integrations):

- `POST /upload` — multipart `batch`, `post`, `file`, `name`, `license`, `duration` (ms, as the
  browser read it). Admins; 415 for a format other than mp3/m4a/aac/wav, 413 over 25 MB. Stored
  at `<owner>/<batch>/audio/<post>/<id>.<ext>`; a WAV's length is read from its header, an m4a's
  from `mvhd`. Ledger row `audio.upload` at estimate 0.
- `GET /list?batch=&post=` — the post's tracks with `access` and `generated: {connected: false,
  reason}`. Every signed-in user.
- `GET|HEAD /file?batch=&id=` — the track with Range (`serveObject`). Every signed-in user.
- `POST /choose {batch, index, videoId, choice, audioId?}` — writes `audio_choice` / `audio_id`
  (migration `0071_video_audio.sql`) on the version; `upload` and `generated` need a track of the
  same kind. Admins. Ledger row `audio.choose` at estimate 0. Nothing is sent anywhere.
- `POST /generate` — **not built**: answers 503 "Generated music is not connected: add a
  Freepik/Magnific key or a Higgsfield key under Connection…" and writes a `refused` ledger row
  (`audio.generate`), so the panel shows who asked.

`GET /list` on the videos carries `audioChoice`, `audioId`, `audioName` per version; a version
with no choice shows what its generation settings imply (engine sound on or off).

Tests: `tests/video-audio.test.ts` (member 403, switch off 503, upload and list, Range/HEAD/416,
choose and the ledger, generate 503 with a refused row, 415 and 413), under the paid guard.

## Limitations

- No overlays after generation: a clip made from the bare picture has no words; a clip made from the artwork has the words baked into every frame and cannot be edited later.
- No automatic retry, ever; a failed clip is a version with its message and a manual "Try again" (a new op).
- The estimate is per request and may differ from the provider's final charge; `reported` is left to the governance branch (the op is updated to `done`/`failed` without an amount).
- The catalog is a snapshot of the docs; models, limits and availability change on the provider's side, and the account may not have every model enabled.
- No transcoding on the Worker: what the provider sends is what is stored and served.
- An uploaded track is not mixed into the clip here: the mp4 stays as it is until the browser-side
  Video editor writes a new version with the track in it.
