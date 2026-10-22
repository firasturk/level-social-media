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
- The top bar's **Photo studio** and **Text studio** switch to those on the same post.

## The top bar

The post number and title, the clips' state (*No clip yet*, *3 clips*, *Making…*, *Failed*),
undo / redo (over the timeline; the scissors split at the playhead), **Versions · n**,
**Photo studio**, **Text studio**, **Save cut** (on Edit, admins), **Close**. Closing with an
unsaved cut asks *Save and close* or *Close without saving*; closing during an export asks first.

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
(**Popular, Paid Ads, Motion Design, Marketing, Production, UGC, Faceless, Effects, Genjutsu,
Recipes**, as Firas saw them), a search box, and the cards. Each card carries the provider's own
**reference video**, which plays on hover (or on a tap) muted and looping, with the preview image
as its poster when there is one; the title; one line of description; chips (the slash command, the
source, the category); *Needs: 1 product picture*; **Use this preset** and **Learn more**. The
video is hotlinked from Higgsfield as its own page does it: the studio never copies it.

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
panel says so and offers *Use this preset* instead).

**Sources behind the categories** (`server/video-presets.ts`, `CATEGORY_ASKS`):

| Category | `get_presets` asks |
| --- | --- |
| Popular | the combined feed (no `source`) |
| Paid Ads | `source: marketing_studio, query: "ad"` |
| Motion Design | `source: marketing_studio, category: "motion"` |
| Marketing | `source: marketing_studio, category: "product-shot"` + `category: "ads"` (merged) |
| Production | `source: katana, katana_source: "higgsfield"` (no query; searched locally) |
| UGC | `query: "ugc"` |
| Faceless | `query: "faceless"` |
| Effects | `source: viral` |
| Genjutsu | `source: genjutsu, category: "genjutsu-trending"` |
| Recipes | `get_preset_instructions` with no preset (the recipes and commands list) |

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
Hero Shot", "Magnific · Kling 2.1 Master", "Video studio cut", "Uploaded"), length, source, cost
(or *free*), the audio choice, the state, the idea, and the client's answers on that version from
the approval link ("Client: approved · Mona · 22 Oct"). **Show** puts a version on the stage;
**Compare** puts a second one beside it; **Select for client review** / **Client version**;
**Edit** opens it on the timeline; a download. The picture is a version too: with no clip
selected, it is what the client sees.

### Check

Higgsfield's reading of the shown clip: the **Virality check** (`virality_predictor`: the hook,
attention, retention, audience) and the **Video analysis** (`video_analysis_create`, a job the panel
polls with `video_analysis_status`). Each runs only on an admin's click with the cost rule (a
`get_cost` preflight when the tool offers one, else "cost not known" confirmed); the words are kept
on the version (`settings.check`, `settings.analysis`) and shown under the cards. A tool the plan
does not list says *Not available on this plan*. Nothing is made or changed by a check.

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

## Verified

- `tests/video-presets.test.ts` (10 tests): the normalisation of presets, needs, previews and
  recipes; Not signed in with no call; a member browsing the combined feed, the encrypted cache
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
  list ten categories, four cards each with a muted looping inline `<video>`, the command chips and
  *Needs*; the search leaves one card; an empty category says so; Learn more opens the detail with
  the video large, the run button and the instructions; Use this preset opens Generate with the
  preset's words, the "From the preset" note, the engine chips and Get the cost; Versions, Enhance
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
