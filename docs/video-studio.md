# Video studio

One full-screen workspace for a post's videos, with the same shell as the Photo studio: a top bar,
a rail of tools on the left, the stage large in the middle, the chosen tool's panel on the right.
On a phone (≤ 860 px) one panel shows at a time, picked from a bottom toolbar of the same seven
icons, and the top bar's buttons keep their icons only.

It grows out of the Video editor (docs/video-editor.md), which is now the studio's **Edit** tool:
the timeline, auto edit, music sync, colour and export are unchanged and still render in the
browser. Around it the studio connects everything about videos: Higgsfield's **preset gallery**
with each preset's own reference video (the ask's core), **Generate** (the Video dialog's content,
plus Magnific's engines), **Enhance** (the providers' tools on a clip), **Audio**, **Versions** and
**Check**. Nothing is made or spent without the confirm each tool asks; members browse and look,
admins run (docs/integrations.md).

## Where it opens from

- The card's clapperboard (now shown on every post with a picture, not only on posts with a clip)
  and the card menu's **Video from this picture**: the studio opens on **Generate** when the post
  has a clip, on **Presets** when it has none.
- **Edit in the Video editor** on a version (the post editor's Versions group, the Video dialog):
  the studio opens on **Edit** with that version on the timeline.
- The Video dialog keeps working as it was and has **Open the Video studio** at its top (the
  dialog closes, the studio opens on Generate).
- `/video-editor` (the Sidebar's "Video editor"): the standalone editor with no post, footage from
  this computer only, the export saved as a file. It shows the Edit tool alone.
- The top bar's **Photo studio** and **Text studio** switch to those on the same post; the Photo
  and Text studios have **Video studio** (the card's clapperboard under the T) back. The cut not
  saved yet, its music file and LUT, and the version shown travel with the switch (the card's
  editing session, `docs/photo-studio.md` → *Moving between editors*).

## The top bar

The post number and title, the clips' state (*No clip yet*, *3 clips*, *Making…*, *Failed*),
undo / redo (over the timeline; the scissors split at the playhead), **Versions · n**,
**Photo studio**, **Text studio**, **Save cut** (on Edit, admins), **Close**. Closing with an
unsaved cut asks *Save and close* or *Close without saving* (which also drops the cut from the
card's session); closing during an export asks first. Switching to the Photo or Text studio keeps
the unsaved cut in the session, and the Photo / Text studios' **Save & return** saves it with the
rest of the post's edits (admins; the server decides).

## The seven panels

| Panel | Icon | What it costs | Who |
| --- | --- | --- | --- |
| **Presets** | grid | browsing is free (the list is kept a day); running a preset: the credits its detail names, or "cost not known" confirmed | everyone browses; admins run |
| **Generate** | sparkles | Higgsfield: the credits `get_cost` names (sign-in) or the Cloud key's estimate; Magnific: the credits `simulate_cost` names | admins |
| **Edit** | scissors | free: rendered in the browser (saving a cut and storing an export need the `editor` switch) | everyone looks; admins save and export |
| **Enhance** | wand | per tool: Magnific's simulated credits, Higgsfield's `get_cost` when the tool offers one, else "cost not known" confirmed | admins |
| **Audio** | music | free (an upload is stored; nothing is sent to a provider) | admins write; members read |
| **Versions** | history | free | everyone |
| **Check** | scan | Higgsfield's `get_cost` when the tool offers one, else "cost not known" confirmed | admins |

The rail marks the paid tools with a small lock for members.

### Presets (the gallery)

The stage shows Higgsfield's presets page inside the studio: the category list on the left
(**Popular, Paid Ads, Motion Design, Marketing, Production, Faceless, Effects, Genjutsu,
Recipes**, as Firas saw them minus UGC: see the table below), a search box, and the cards. Each card carries the provider's own
**reference video**, which plays by itself while on screen, muted and looping, with the preview image
as its poster when there is one; the title; one line of description; chips (the slash command, the
source, the category); *Needs: 1 product picture*; **Use this preset** and **Learn more**. The
video is hotlinked from Higgsfield as its own page does it: the studio never copies it. The
references play by themselves while on screen (no hover needed), muted, at most six at once, with
pause and sound buttons; a tap on one opens its detail, where it plays large with controls (see
*Autoplaying previews* below).

The right panel shows the picked preset in full: the video large with controls, the description
and chips, what it needs, the cost ("about N credits" or "not known"), whether it is ready for this
post, **Use this preset** (the Generate panel opens with the preset's words, and its engine when it
names one, the post's picture already the first frame), **Learn more** (the instructions text),
and for an admin on a runnable preset **Run this preset · N credits**: the text inputs the preset's
schema asks for, then the confirm, then the run. The result lands under Versions as "Preset ·
Hero Shot". Members see **Admins only for now** in its place.

Nothing is invented: a category Higgsfield answers nothing for says *Nothing in this category on
your plan yet*; a search with no match offers *Search Higgsfield for it* (the provider's own
`query`). Recipes and Katana productions are shown for reference and cannot be run from here (the
panel says so and offers *Use this preset* instead). Switching the category closes the picked
preset's detail, so the side panel never shows a preset from another category.

**Videos only** (`keepCard` / `dropReason` in `shared/video-presets.ts`, applied by `parsePresets`
and `parseRecipes` in `server/video-presets.ts`; a detail lookup passes `all: true` and keeps
everything so a preset can still be opened). A card stays only when it has a real id, a title and
a reference **video**. The provider says which preview is a video: every live entry carries
`preview_url` with `preview_type: "video" | "image"` (and usually `thumbnail_url`); the parser
believes `preview_type` first, so a `/published/<hash>` link with no extension is still the video
when the provider says so, and a product shot whose preview is a picture is a picture preset
whatever its link looks like. Dropped, with the reason named in the tests: an entry with no id; an
entry whose title is a known category name (*All*, *Motion*, *Product shot*, *Effects*, *Ads*,
*Viral*… — the presets page's filter list once came back as four such "presets"); an entry with no
preview and no description; a preset whose preview or declared output is a picture (those belong to
the Photo studio's Presets); any other card with no reference video (a picture-only card is never
shown in the Video studio, whatever output it declares). Recipes stay only when they
make a video from a picture (`isVideoFromPictureRecipe`): their words say video / clip / reel /
motion, name a picture they take (or their `inputs` do, or the provider's own `runnable` flag is
not false), and do not point at another tool — Blender, After Effects, DaVinci, websites, games,
3D, code, shaders, influencers, voices and the like are not the Video studio's (so *2d character*,
*3d jutsu*, *ads studio*, *build ai influencer*, *cartoon shaders*, *color grading*, *content
factory*, *destruction studio*, *exploded view*, *faceless* go). Every card carries `output`
(`"video"`, `"image"` or null) for the studio to read.

**Sources behind the categories** (`server/video-presets.ts`, `CATEGORY_ASKS`):

| Category | `get_presets` asks |
| --- | --- |
| Popular | the combined feed (no `source`), 50 at a time |
| Paid Ads | the combined feed with `query: "ad"` |
| Motion Design | `source: marketing_studio, category: "motion"`, two pages, without the `hypermotion` type (the `saas_motion`, `2d_motion` and `mixed_media` graphics and looks) |
| Marketing | `source: marketing_studio, category: "motion"`, two pages, the `hypermotion` type only (product macros, logos, price rolls, HUDs), plus `query: "product"`, `"logo"` and `"unboxing"` (merged; the `product-shot` category is pictures only) |
| Production | `source: katana` (the community catalog; `katana_source: "higgsfield"` answers nothing; no query, searched locally; 20 is Katana's maximum page) |
| Faceless | `source: what_if` (the "What if" explainer styles: scenes, text and data, no presenter; no query, searched locally) |
| Effects | `source: viral` |
| Genjutsu | `source: genjutsu, category: "genjutsu-trending"` |
| Recipes | `get_preset_instructions` with no preset (the recipes and commands list) |

Every ask takes the provider's maximum page (50; Katana 20) because picture presets in the answer
are dropped afterwards. A category's asks go out together; an ask that fails (a 503 from the
provider, say) is left out instead of emptying the category, and the error is thrown only when every
ask failed. The Marketing Studio's 231 videos all sit in its `motion` category, interleaved by four
provider `type`s; Marketing and Motion Design split them by that type rather than by a category the
catalog does not have. There is **no UGC category**: `get_presets` with `query: "ugc"` (and
`"faceless"`, `"talking"`, `"creator"`, `"influencer"`) answers nothing on 22 Oct 2026; Higgsfield's
UGC ads live in its Marketing Studio widget (`show_marketing_studio_v2`), which is not a catalog
the studio can list. A search typed in the gallery is sent as `query` joined to the category's
own words (every word must match on the provider's side); Katana and What if are searched here.

Each category's cards are cached a day in the settings row `video_presets_cache_<category>`
(encrypted like every setting) and in the isolate; the gallery's refresh button asks again
(`?refresh=1`). A detail (`GET /:id`) is cached an hour in the isolate.

### Generate

The Video dialog's content, moved in: the motion idea (written from the picture, dictated or
typed), the provider (**Higgsfield** or **Magnific**), the engines as compact chips (the
subscription catalog with "Refresh list" when the billing is the credits, the Cloud catalog when it
is the key), length and frame as the engine allows, **Include the words and logo in the video
input**, the cost line, **Get the cost** then **Make the video · N credits** (or *Make it anyway,
cost unknown*), the unlimited-allowance question as two buttons. The Magnific section lists its
video engines (`video_models_list`, recommended ones first with a star, cached a day), length and
frame from the engine's lists, *With sound effects*, **Get the cost** (`simulate_cost`) then
**Make the video · N credits** (`video_generate` with the post's picture as the start keyframe).
A clip whose cost Magnific cannot simulate is not made (the Freepik MCP rule). The running clip
shows on the stage with its state; the versions are read again every few seconds until it lands.

**Frame** (`shared/video-frame.ts`, `src/studio/FrameControl.tsx`, `src/video-editor/frame.ts`):
every generated video is a **Reel 9:16** unless the person picks **Portrait 4:5**, **Square 1:1**
or **Landscape 16:9**; the last choice is remembered per month in the browser
(`lsm-video-frame-<batch>`). How the frame reaches the engine (`frameRoute`): an engine whose
frame options include it is handed the frame (Higgsfield MCP `aspect_ratio`, Magnific
`aspectRatio`, Cloud `aspect_ratio` where `shared/video-models.ts` lists one); an engine that
follows the picture's frame gets the picture **composed to that frame in the browser first**
(`composeFrame`: the post's picture, or the artwork with its words and logo, on a canvas of that
frame — **Crop to fit** covers the frame centred, **Blur the edges** keeps the whole picture over
a blurred, darkened copy of itself) and sent as `source: "artwork"` with the composed JPEG data
URL. The control says which of the two happens for the chosen engine. The submit bodies take
`frame` (one of the four), `fill` (`crop` | `blur`, only when the browser composed) and `words`
(the words and logo drawn in or not); the version stores them in `settings.frame`,
`settings.frameFill`, `settings.words` and lists them as `frame`, `frameFill`, `words` ("Reel 9:16
· cropped to fit · bare picture" under Versions, "Video · 5s · Reel 9:16" on the card's badge). The
Video dialog has the same control. The Prompt Box's video card defaults to **Frame: Reel 9:16**
and hands the frame to an engine that takes it; with no browser to compose in, an engine that
follows the picture keeps the picture's frame there and the note says to open the Video studio.
Enhance results inherit the frame of the version they start from (a Higgsfield Reframe sets it).

### Edit

The editor as it was (docs/video-editor.md): its five tabs (Clips, Auto edit, Music, Colour,
Export) sit at the top of the panel; the preview, transport and timeline take the stage. Undo /
redo and the split in the top bar act on the timeline. New finished versions (a preset run, a
Magnific clip, an enhance result) join the footage as they land.

### Enhance

On the shown version. Magnific: **Upscale** (Topaz / Magnific / Precision), **Colour grade** (a
LUT from `video_luts_list` with an intensity, or the seven sliders), **Music** (a prompt and how
the clip's own sound is mixed), **Sound effects**, **Relight**, **HDR**. Higgsfield: **Upscale**,
**Reframe** (9:16 / 1:1 / 4:5), **Remove the background**. Each card says what the tool is for;
the run asks the cost first (Magnific's `simulate_cost`; Higgsfield's `get_cost` when the tool's
input schema lists one, else "cost not known" until confirmed), then runs once; the result becomes
a new version of the same post labelled "Upscale (Magnific) of an earlier version" and shows on the
stage. A Higgsfield tool the plan does not list is shown greyed with *Not available on this plan*.

To hand one of our clips to Magnific it is uploaded as a **creation** once and the id is remembered
on the version (`settings.magnificCreation`): `creations_upload_file` with a signed link when the
live tool list has it with a `url`-like parameter, else `creations_request_upload` → PUT of the
bytes → `creations_finalize_upload`. A tool whose schema takes `videoUrl` and no
`creationIdentifier` gets a signed link instead and no upload is made.

### Audio

The Video dialog's Audio block for the shown version (engine sound or none, an uploaded track with
its licence line, generated music when a provider is connected, the Instagram note), written on the
version by an admin; members read it. An uploaded track is mixed in by the Edit tool's export.

### Versions

Every clip of the post, newest first: the poster, who made it ("Higgsfield (credits) · Preset ·
Hero Shot", "Magnific · Kling 2.1 Master", "Video studio cut", "Uploaded"), length, frame ("Reel
9:16 · cropped to fit"), source (words and logo, or the bare picture), cost (or *free*), the audio
choice, the state, the idea, and the client's answers on that version from the approval link
("Client: approved · Mona · 22 Oct"). **Show** puts a version on the stage; **Compare** puts a
second one beside it; **Select for client review** / **The client sees this** with **Show the
picture instead**; **Edit** opens it on the timeline; a download. The picture is a version too:
with no clip selected, it is what the client sees.

**The client's version is set by itself.** When a clip finishes — any provider: the settlers
(`storeFinishedClip`), an upload, the editor's export, an Enhance result (`storeVideoFile`) — and
the post has no `for_client` row yet, that clip is marked for the client
(`autoSelectForClient` in `server/video.ts`: one `UPDATE … WHERE NOT EXISTS (… for_client = 1)`,
so two clips landing together cannot both win). A later clip never replaces a chosen one; the team
changes or clears the choice under Versions (`POST /select`). The share page plays the client's
version as before (`server/share.ts` `clientVideos`, `src/share/SharePage.tsx`), on the feed cell
too; the card's badge says *the client sees this*.

### Check

Higgsfield's reading of the shown clip: the **Virality check** (`virality_predictor`: the hook,
attention, retention, audience) and the **Video analysis** (`video_analysis_create`, a job the panel
polls with `video_analysis_status`). Each runs only on an admin's click with the cost rule (a
`get_cost` preflight when the tool offers one, else "cost not known" confirmed); the words are kept
on the version (`settings.check`, `settings.analysis`) and shown under the cards. A tool the plan
does not list says *Not available on this plan*. Nothing is made or changed by a check.

## Autoplaying previews (one behaviour for every surface)

Every clip in Level Studio is drawn by one component, `src/components/AutoplayVideo.tsx`, whose rules
live in `shared/video-preview.ts` (tested in `tests/video-preview.test.ts`), the way Higgsfield's
pages behave:

- **A visible clip plays by itself**: muted, inline (`playsinline`, `webkit-playsinline`, the
  `muted` attribute and property set before the file loads, so iPhone Safari allows it), looping on
  cards. It plays once at least 35% of it is on screen (or it covers half the screen, for a large
  player), and pauses when it leaves the screen, when the tab goes to the background
  (`visibilitychange`), when its dialog or panel closes (`active={false}`, or it unmounts), and
  while a dialog or the full-screen Video studio lies over it.
- **At most 6 play at once**: the player stages and dialogs first, then the clips the person
  started or unmuted, then the most visible.
- **The file loads only near the screen** (300 px ahead): until then the `<video>` has no `src`
  and `preload="none"`; after, `preload="metadata"`. The poster shows until playback is ready;
  with no poster, a `#t=0.001` fragment paints the first frame.
- **The person's choices win**: a pause (our button or the browser's controls) is never undone by
  scrolling, a re-render or the tab coming back, and the playhead is never moved. A player that
  reached its end waits on its last frame. A new clip (another `src`) starts fresh.
- **Sound only from a person's action**: a sound button on every clip (bottom right on cards,
  top right on players); unmuting one mutes the one before, so only one clip is audible.
- **Modes**: `preview` (cards, galleries, lists: pause and sound buttons, no native controls,
  looping), `player` (Video dialog, version stage, preset detail, client link: the browser's own
  controls for seeking, volume and fullscreen, never forced fullscreen; starts muted with the sound
  button), `editor` (a working preview a timeline drives: never started, paused or seeked by these
  rules except a background tab; the editor's own canvas preview is not a `<video>` and is not
  touched), and `decorative` (the studio's hero banners: no buttons, hidden from screen readers).
- **Fallbacks**: a refused autoplay (Low Power Mode, a browser setting) shows a **Play** button
  over the poster; a broken lightweight preview falls back silently to the full file; a broken file
  shows the poster with **Try again**. Under **reduced motion** nothing starts by itself: the poster
  (or first frame) stays with **Play (reduced motion)**; heroes show a small Play in their corner.

Surfaces: the Studio card (`VideoOnCard`, the clip over the picture; the badge switches back to the
picture), the Video dialog, the Video studio's version stage, its Versions list thumbnails, the
editor's Versions group (`VideoVersions`), the preset gallery cards and detail, the client review
link (`/share/<token>`, each post's clip as a muted player; the feed grid stays poster thumbnails
that link to the post), and the hero banners (Studio workspace, Admin preview). The Photo studio,
Freepik and style galleries show pictures only.

### What is lightweight, exactly

Workers cannot transcode and no outside service is used, so the light versions are made **in the
browser** when a clip is stored (`src/lib/video-rendition.ts`) and kept next to the clip in R2:

- **Still** (`<clip>.still.jpg`, 540 px on the short side, JPEG 0.8): the clip's own first frame.
  Any browser that can play the clip makes it. `GET …/poster` serves it when present (else the
  picture the clip started from), on the studio and on the client link.
- **Preview mp4** (`<clip>.preview.mp4`): the **first 8 seconds**, 360 px on the short side, 24 fps,
  about 700 kbit/s, **no sound**, H.264 with the index in front. Made with WebCodecs, so only where
  the browser has an H.264 encoder (Chrome, Edge, Safari on a computer); kept only when it is
  clearly lighter than the clip (under 80% of its size). Served at `GET|HEAD …/preview` (Range, the
  same access as the file) and listed as `preview` on each version.
- **When**: at the video editor's export and at an upload (both through
  `src/video-editor/api.ts`), and, for a clip an engine delivered (Higgsfield, Magnific), after an
  admin has had it on the Video studio's stage for 4 seconds (`POST …/preview`, admins only, once per
  clip per session; it fetches the full file once to do so).
- **Who uses it**: the Studio cards and the versions lists play `preview` with the full file as
  the fallback. The version stage, the Video dialog, the client link and the editor and export
  always use the **full file**.
- **Not lightweight**: a clip with no rendition yet (engine clips nobody opened in the studio as an
  admin, clips stored from a browser without an H.264 encoder) plays its full file on cards, loaded
  only near the screen with `preload="metadata"` and the 6-clip cap. Higgsfield's preset references
  are the provider's own preview files, hotlinked as before.

## Routes

All under `/api/studio/video`, mounted from `server/studio.ts`:

- `GET /presets?category=&q=&cursor=&refresh=1` (every member) → `{items[], nextCursor, cachedAt,
  cached, categories, signedIn, admin, access, billing, reason, empty}`. Not signed in or switched
  off: `items: []` with the reason, no call. A fetch from the provider writes one free ledger row
  (`preset.browse`).
- `GET /presets/:id?source=&batch=&index=` (every member) → `{preset: PresetDetail,
  readinessError, admin}`: the lookup (`preset_id` + `category: "all"`, the source when known), its
  `execution` block (`available`, `input_schema`, `readiness`), a price when the answer carries one,
  the instructions of its command (`get_preset_instructions {preset}`); for an admin with
  `batch`+`index`, the post's picture is imported (`media_import_url`) and offered as the preset's
  picture input (`initial_inputs`) so the readiness is for exactly this post.
- `POST /presets/run {batch, index, presetId, source, inputs?, confirm?}` (admins, the
  `higgsfield` switch, the billing must be the credits) → 409 `{needsConfirm, credits, balance}` or
  `{needsEstimate}` until confirmed; then a claim (ten minutes), a ledger row `preset.run`,
  `execute_preset {source, preset_id, inputs}` once, the job ids → a `videos` row with
  `provider = 'higgsfield-mcp'`, `model = preset:<id>`, `request_id` = the first job id, settings
  `{preset: {id, name, source, command}, jobIds, label, inputs, credits, …}`; the existing settler
  (`settleMcpPending`) collects it with `jobs_wait` and stores the mp4 in R2.
- `GET /magnific/status` (every member); `GET /magnific/models?refresh=1`, `GET /magnific/luts`
  (admins; cached a day as `magnific_video_models` / `magnific_video_luts`);
  `POST /magnific/generate {batch, index, slug, prompt, duration, aspectRatio?, resolution?, source?,
  artwork?, withSoundEffects?, confirm?}` and `POST /magnific/enhance {batch, videoId, tool,
  arguments?, confirm?}` (admins, the `freepik` switch): `simulate_cost` → 409 `{needsConfirm,
  estimate}` → confirm → the tool once → the creation identifiers → a `videos` row with `provider =
  'magnific'` polled by `settleMagnificPending` (`creations_wait {identifiers, timeoutSeconds: 1}`).
  An unknown cost answers 409 `{blocked: true}` with a `refused` ledger row (kinds `video.generate`,
  `video.enhance` under provider `freepik`).
- `GET /higgsfield/tools` (every member: which of the six tools the live server lists);
  `POST /higgsfield/tool {batch, videoId, tool, arguments?, confirm?}`; `POST /higgsfield/check
  {batch, videoId, tool, confirm?}`; `GET /higgsfield/check/status?batch=&videoId=` (admins, the
  `higgsfield` switch, the credits billing; ledger kinds `video.enhance`, `video.check`).

`GET /api/studio/posts/video/list` now carries `label`, `check` and `analysis` per version.

## Members and admins

Browsing the gallery, opening a preset, looking at the versions, the audio choices and the checks
already made is open to every member of the month. Running a preset, making a clip, an enhance, a
check and writing the audio choice are admins only for now, under each provider's switch, with a
ledger row and a confirm before spend, as docs/integrations.md says. The panels say **Admins only
for now** and keep the controls off for members.

## What is assumed about the tool answers

Nothing here ran live: no sign-in, no preset, no clip, no Magnific creation. Every shape below
comes from the tool descriptions the MCP servers list and is read defensively
(`server/mcp-client.ts`: `structuredContent`, else the first JSON text block, else the words);
`tests/video-presets.test.ts` and `tests/video-studio.test.ts` fix the shapes the studio
understands.

- **A preset** is any object with an id (`preset_id`, `id`, `slug` or `command`) and a name
  (`name` or `title`). Its reference video is read from `video_url`, `preview_video`,
  `reference_video`, `demo_video`, `video`, …, its poster from `poster`, `thumbnail`,
  `image_url`, `preview_image`, `cover`, …; a `preview` / `media` / `example` value (a link, an
  object with `url` and a `type`, or a list of them, one level deep) is sorted by its declared type
  or its extension, and a bare link with neither is taken as the video. The command comes from
  `command`, `slash_command`, `slash` or `cmd` (the slash added when missing). The price from
  `price`, `credits`, `cost`, `price_credits`, …; an engine from `model` / `engine`; a prompt from
  `prompt` / `default_prompt` / `prompt_template`. `execution.available` is capability, not
  permission; `runnable` is that plus a source `execute_preset` takes (viral, marketing_studio,
  genjutsu).
- **Needs** are derived from the required properties of `execution.input_schema` (or a preset's
  `inputs` list): an image-like field → "1 product picture" (or "N pictures" from `minItems`), a
  video-like field → "a video clip", a text field → "a few words of prompt".
- **The picture input** of a run is the first image-like field of the schema; it receives the
  imported media id as a string, or `[{id, type: "image"}]` when the field is an array (the
  `initial_inputs` shape the Higgsfield instructions show for character sheets). The same field is
  prefilled for the readiness lookup.
- **Recipes** (`get_preset_instructions` with no preset) are objects with a command and a title
  or description, or lines such as `- /hero-shot — A product reveal`.
- **`execute_preset`** answers job ids like `generate_video_batch` (objects with `job_id`); the
  first is the version's job, the rest are noted in `settings.jobIds`. An unlimited-allowance
  question in its answer is surfaced as 409 and never answered by the server.
- **Magnific engines** are objects with a `slug` (`name`, `description`, `durations`,
  `aspectRatios`, `resolutions`, `agentRecommendation` or `recommended`); **creation identifiers**
  are `identifier` / `creationIdentifier` strings (or an `identifiers` list); **`creations_wait`**
  answers objects with an identifier, a `status` and a file link under `url`, `fileUrl`,
  `videoUrl`, `downloadUrl`, `files[].url`, …
- **Higgsfield's clip tools** receive the clip under the parameter their input schema declares:
  `media_id` (an imported media; the default when the schema is empty), `medias` (as
  `[{value, role: "video"}]`), `video_id`, or a signed link under `video_url` / `url`; a schema
  that nests everything under `params` is given the same nesting. A `get_cost` parameter in the
  schema makes a preflight; otherwise the cost is "not known".
- **`video_analysis_status`** takes the analysis id under the first of `analysis_id`, `analysisId`,
  `job_id`, `id` its schema declares; "done" is a status such as completed / done / ready.

## What the first live run must check

1. **The gallery**: open a post's Video studio on Presets with the Higgsfield sign-in made; each
   category should fill (Admin → Integrations shows a free `preset.browse` row per category). If a
   category stays empty while Higgsfield's page shows presets, read the stored answer (the tool's
   text in the browser's network tab, or call `get_presets` from Claude's own Higgsfield MCP) and
   widen `parsePresets` in `server/video-presets.ts`: the field names of the id, the name and the
   preview are the likely difference.
2. **The reference videos**: hover a card: the video must play. If the provider's links refuse
   hotlinking (a 403 or CORS on the `<video>`), the cards fall back to the poster; the link's host
   and headers then say whether a signed or proxied URL is needed (today nothing is proxied: the
   provider's own page hotlinks them).
3. **A preset's detail**: Learn more must show the instructions text; *Needs* and *Ready?* must
   match what Higgsfield's page says. For an admin, the ledger shows one `media_import_url` of the
   post's picture (cached an hour).
4. **A preset run** (an admin, one cheap preset): the confirm names the credits from the detail
   (or says the cost is not known); the version appears queued with a job id, turns done with the
   mp4 playing; the `preset.run` row reads "N credits reported (balance a → b)". Check
   `settings.jobIds` when the answer carried more than one job.
5. **Magnific**: the Generate panel's Magnific section lists engines; "Get the cost" shows the
   simulated credits; one clip lands as `provider = 'magnific'`. For Enhance on an uploaded clip,
   check which upload tool the live `tools/list` offered (the ledger note says "clip as …") and
   that the creation id was remembered on the version.
6. **Higgsfield's clip tools**: the ledger note says how the clip was handed over ("media id as
   media_id", "link as video_url"); if a tool refuses the parameter, its input schema (Claude's
   own `tools/list`) names the right one and `clipArgs` in `server/video-enhance.ts` takes it.
7. **Check**: the virality words land on the version; a video analysis turns from running to done
   within a few polls.

### What the live run found (23 Oct 2026, production, a temporary admin, deleted after)

- **The gallery**: every category fills with reference videos that play on hover (Popular 36,
  Paid Ads 18, Motion Design 75, Marketing 28, Production 20, Faceless 56, Effects 50, Genjutsu
  50, Recipes 2); no picture card.
- **Generate** (Higgsfield · credits): the engines list; "Get the cost" for 5 s from the post's
  picture, Reel 9:16: Seedance 2.5 35, Kling v3.0 8.75, Kling 3.0 Turbo 7.5, MiniMax H3 10
  credits; the balance unchanged by the estimates. One Kling 3.0 Turbo clip on post 2: queued
  with a job id, done, the ledger "7.5 credits reported (balance 5604.75 → 5597.25)"; it became
  the client's version by itself and the client link carries it.
- **Magnific engines**: the list answered "Magnific listed no video engine the studio could read"
  (502): `video_models_list` answers a compact YAML-like text, not JSON. `parseYamlish` in
  `server/mcp-client.ts` reads it; 12 engines list now, `private: true` ones left out.
- **Enhance and Check**: the live `upscale_video` nests `{provider, video_id, …}` under `params`
  (Topaz needs no source size; ByteDance requires width and height), `reframe` takes `medias`
  with a `video` role, the Virality Predictor `{action: "create", params: {model, medias:
  [{id, role}]}}`; `clipArgs` and `shaped` follow `toolShape`. Not run live yet (each costs).
- **Versions**: "Select for client review" on an older clip (made before the first-clip rule)
  puts it on the client link at once.

## Verified

- `tests/video-frame.test.ts` (9 tests): the four frames and their labels, the frame sizes, the
  cover and contain placement maths (a 4:5 picture into a Reel, a landscape picture, a picture
  already in the frame), the frame a picture has, how a frame reaches an engine (aspect option or
  composed) and the words for it, the remembered choice. `tests/video.test.ts`: the frame on the
  Cloud path (composed artwork with `fill`, handed as `aspect_ratio` to Kling 2.6 Pro, an unknown
  frame or fill refused, older versions with no frame); the first finished clip shown to the client
  by itself (an upload, a provider's clip collected on list), a later clip not replacing it, "Show
  the picture instead" and the next clip taking the place; `tests/higgsfield-mcp.test.ts` and
  `tests/video-studio.test.ts`: the frame stored on the MCP and Magnific versions, the finished
  clip as the client's; `tests/video-editor.test.ts`: the export as the client's version when the
  post had none (its expectation changed from `forClient: false`).
- `tests/video-presets.test.ts` (11 tests): the normalisation of presets, needs, previews and
  recipes; the videos-only rules (the category list as four cards, no id, no preview and no
  description, a picture preset, a picture-only card with no video output, each with its reason;
  a picture preview with a video output kept; `all: true` for the detail); recipes kept only when
  they make a video from a picture (Blender, DaVinci, website, influencer, render, script ones
  dropped); Not signed in with no call; a member browsing the combined feed, the encrypted cache
  row, the day's cache from the isolate and from the row, `?refresh=1`, the next page by cursor,
  the free ledger rows; every category's asks (two for Marketing, Katana for Production, the
  recipes list, the empty answer, the search as `query` except for Katana); the detail for a member
  and for an admin (the readiness with the picture prefilled), a recipe's detail; a run refused to
  a member, on the Cloud billing, for a recipe, with the switch off (browsing still answering);
  the confirm with the detail's price → `execute_preset` with the picture in the input → two job
  ids → `jobs_wait` → the mp4 in R2 served with Range → the ledger row done; a preset with no price
  blocked as "cost not known" until confirmed.
- `tests/video-studio.test.ts` (9 tests): the Magnific answer shapes; Not connected and Admins
  only; the engines cached a day, the LUT list; a clip from the picture (`simulate_cost` with the
  signed keyframe → `needsConfirm` → `video_generate` → a `magnific` version → `creations_wait` →
  the mp4 → the ledger); a cost that cannot be simulated blocked, the switch off 503; an enhance
  (the upload as a creation once: request → PUT → finalize, the id remembered; `video_hdr`,
  `video_color_grade` with a LUT, `video_upscale` with a mode; spoofed identifiers dropped); the
  upload by link when `creations_upload_file` takes a `url`; Higgsfield's tool list and
  availability; `upscale_video` with the clip imported as a video media, the `get_cost` preflight,
  the confirm, the job → a version; a tool with no `get_cost` as "cost not known"; the Cloud
  billing refused; the virality check with the clip as a link and the words on the version; a
  check tool the panel does not offer refused; an analysis started and polled to its answer; a
  member refused.
- Browser (`scripts/video-studio-smoke.mjs`, headless Chromium against the built app and a boot
  mock with fixture presets whose reference videos the script serves): the month opens, the card's
  clapperboard opens the studio on Presets (no clip yet), the rail shows seven tools, the category
  list nine categories, five cards, each with a muted looping inline `<video>`, no picture tag and
  no blank box, the command chips and *Needs*; the search
  leaves one card; switching the category closes the picked preset's detail; an empty category says
  so; Learn more opens the detail with the video large, the run button and the instructions; Use
  this preset opens Generate with the preset's words, the "From the preset" note, the engine chips
  and Get the cost; the Frame control opens on Reel 9:16 with four frames, says the fixture's
  Seedance takes the frame itself (no fill asked), shows the fill and "made Reel 9:16 here" for an
  engine with no frame option, and remembers Square 1:1 · blur in `lsm-video-frame-b1`; Versions, Enhance
  (five cards), Check (a tool greyed as not available) and Edit (five tabs) mount; at 390 px the
  rail gives way to a bottom toolbar of seven tools with no sideways scroll. No page errors, no
  request outside the test server. Screenshots at 1440 (Presets, the detail, Generate, Edit) and
  390 (Presets, Generate) were inspected; the header's refresh button and the title at 390 were
  fixed from them.
- `scripts/video-editor-smoke.mjs` still passes for the standalone editor (one Edit tool on the
  phone's toolbar, its five tabs inside the panel, the H.264 stop message).
- The gate chain (`npm run typecheck && npx eslint . && npx vitest run && npm run build`) is
  green; the studio stays in its own lazy chunk (`VideoEditor-*.js`, with `video-studio.css`).
- Not verified in a browser: a real preset, a real clip, a real enhance or check (the fixtures and
  the mocks only; no paid call was made); the reference videos playing (the Playwright Chromium has
  no H.264 decoder, so the hover shows the poster); dictation; the Photo studio ↔ Video studio
  switch on a saved month (typed and built, not clicked).
