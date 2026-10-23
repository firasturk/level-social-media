# Photo studio

One full-screen workspace for a post's picture, with the same shell as the Text studio: a top bar,
a rail of tools on the left, the picture large in the middle, the chosen tool's panel on the
right. On a phone (≤ 860 px, the Text studio's own breakpoint) one panel shows at a time, picked
from a bottom toolbar (seven buttons: Presets and AI tools share one **AI** button so eight tools
fit 390 px), and the top bar's buttons keep their icons only.

Two panels came from the Video studio's preset gallery, pictures only, at Firas's ask ("the
gallery shows videos mixed with pictures; I liked the pictures. Move that experience to the picture
editor and separate pictures from video" and "add the Higgsfield and Freepik MCP image tools"):
**Presets** (first in the rail; the panel a post with no picture yet opens on) and **AI tools**.
Both are described under "The eight panels" and "Presets and AI tools" below.

It replaces nothing: every tool it holds is the one the post editor's Image group already offered
(the dialog keeps its tools for now, with a prominent **Open the Photo studio** button at the top of
its Image group and **Open in the Photo studio** on its Versions group). It adds one new tool,
**Adjust**, which is free and drawn in the browser.

## Where it opens from

- The card's **Edit picture** button (and the aperture icon above the picture, beside the T and the
  clapperboard) opens the Photo studio on the **Edit** panel. A post without a picture still opens
  the editor on its idea: the studio needs a picture.
- The post editor's Image group: **Open the Photo studio** (Edit panel); its Versions group:
  **Open in the Photo studio** (Versions panel).
- The Text studio's top bar: **Photo studio** switches to it on the same post (the design is saved
  first). The Photo studio's top bar has **Text studio** and **Video studio** back.

## The top bar

The post number and title, the picture's state (Ready, Review, Making…, Failed), a note when the
client holds the picture (*Client approved: saving makes a new version*), undo / redo (over the
Adjust parameters), **Versions · n** (the count of takes; opens the Versions panel),
**Text studio**, **Video studio**, and **Save & return** (always on screen, also at 390 px). The ✕
closes; with work not saved (here or in another studio of the same post) it asks once:
*Save & return* or *Keep for later* (kept edits wait on the card, nothing is dropped).

## Moving between editors: the card's editing session

The Photo, Text and Video studios are separate overlays, so each card has a small **editing
session** (`src/studio/editing-session.ts`, plain parts in `shared/editing-session.ts`), one per
month + post, kept in memory and in the tab's `sessionStorage`:

| Part | What it holds | Carried across a switch |
| --- | --- | --- |
| `picture` | a take picked under Versions (**Edit this version**) | yes: Photo (canvas, Adjust), Text (the picture under the layers) and Video (first frame, artwork) open on it |
| `videoId` | the clip the Video studio last showed | yes: the Video studio reopens on it |
| `photo` | Adjust settings not applied yet, and the picture they apply to | yes |
| `text` | words and layers not saved yet (only while the client holds the post; otherwise the Text studio saves itself within ~1 s and on every switch) | yes |
| `video` | the cut not saved yet (document, project, save number); its music file and LUT stay in memory only | yes (the music and LUT within the same tab) |
| `held` | the last save kept as a new version because the client holds the current one | shown on the card |

Not carried: the AI edit's instruction text, a marked area, the compare picks, a Photo lab or AI
tool result not yet used (those live on the server's job list and come back with the panel), the
playhead, and anything after a reload of the tab for the music file and LUT (pick them again).

**Save & return** (in the Photo and Text studios) saves every pending part of the session, whichever studio it
was started in — the adjustments are uploaded, the words saved to the plan, the cut saved with the
post (admins; nothing is rendered) — then closes, scrolls
the same card into view and highlights it. A part that fails stays in the session and the editor
stays open with what failed. Closing without saving keeps the parts on the card (*Unsaved edits
kept: … · Open to finish · Discard*); only **Discard** drops them.

## Client-approved and shared versions

`shared/client-hold.ts` says when the client holds a post's current version: they **approved** it
on the review link, or the month's **review link is out** (it shows the current picture). Then:

- a picture save (`POST /picture/upload`) stores the picture and a take but leaves the post's
  picture, the client's answer and the link untouched; it answers `held: "approved" | "shared"`
  and the sentence *"The client approved the current version; your edit is saved as a new version.
  Send it for review to replace it."* (or the review-link variant);
- words and layers wait as a draft; Save & return asks *Save and send for review* or *Keep as a
  draft*;
- "Use this picture" / "Previous picture" ask first, then send the post for review;
- the card shows the sentence with **Send it for review** (`POST /versions/send-for-review`
  `{batch, index, key?}`: the new picture becomes the client's, the one it replaces stays under
  Versions and in the month's earlier pictures, the client's earlier answer is cleared) and
  **Keep the client's**.

Clips are out of this file's scope: the video editor's save, render and client-version rules are
documented with the video editor.

Originals (product uploads, Drive photos) are never written by any of this.

## The eight panels

| Panel | Icon | Costs | Who |
| --- | --- | --- | --- |
| **Presets** | grid | browsing is free; running a product-shot preset is credits from the Higgsfield subscription (said before the confirm) | everyone browses; admins run |
| **AI tools** | sparkles | credits: Higgsfield's subscription or Magnific's balance, the figure asked of the provider before each run (or "cost not known") | admins only for now |
| **Edit** (AI) | wand | one paid picture per edit (the engine's price, said before the confirm) | whoever opened the month |
| **Adjust** | sliders | free: drawn in the browser, nothing is generated | everyone |
| **Photo lab** | flask | Freepik, about the price shown per tool; a demo when no key is saved | admins only for now |
| **Assets** | pictures | Freepik stock: a download is proposed with its estimate (once; then reused); layers and backgrounds are free; the client's Drive is free | Freepik: admins only for now; Drive: everyone |
| **Versions** | history | free | everyone |
| **Check** | scan | the writing check is one Vision call per read when Google Vision is connected | everyone |

**Edit (AI).** The instruction box with dictation; **Mark an area** (drag a box on the picture: it
goes into the instruction in words, where and how big; it is guidance, not a mask, the engine
redraws the whole picture); the reference picture for the edit (attach, change, take off; it stays
on the post for its next takes); the quick instructions as chips; the scope block (*Scope: post N
only. Source: the current picture … What changes: …*); the cost and the confirm. The result shows
on the canvas as **Compare** (the product photo beside the result, a slider), **AI result** or
**Original**. It is the same server call as the post editor's "Edit this picture"
(`revise` on the task); no new route. **Make another version** stays here as the secondary action
with the same confirm as the editor (a fresh picture from the saved idea, not an edit of this one).

**Adjust.** Crop with aspect presets (Free, 1:1, 4:5, 9:16) and a frame with eight handles on the
canvas (drag a side or a corner; drag inside to move; the aspect holds), turn left / right 90°,
flip horizontally / vertically, straighten (±10°, the picture is scaled just enough to keep the
frame filled), then exposure, contrast, saturation, temperature, tint, highlights, shadows,
sharpen (an unsharp mask) and vignette. Double-click a slider to reset it; **Hold for before**
(or hold **C**) shows the picture before; **Reset** clears everything. **Apply as the post's
picture** draws the picture at full resolution and uploads it: it becomes the post's picture, the
previous one stays a take under Versions, and the words and the logo (layers drawn by the page)
are redrawn over it. Undo / redo in the top bar step through the parameters.

**Photo lab.** The four Freepik tools as cards (remove background, replace background, relight,
upscale) with what each is good for and about what it costs in dollars (the Freepik API key); a
note at its top says *Magnific's own tools, paid in credits, are under AI tools*. The picture source (this post's
picture, the client's Drive photos, or an earlier result through *Run another tool on this
result*); a prompt with dictation for the two tools that take one; **Run** proposes the job (the
server writes the estimate to the ledger first), the confirm shows the estimate, and the same
request runs. The result goes on the canvas as before / after; then **Use as the post's picture**,
**Save as a product photo**, **Download**. Earlier results are listed. The logic is one hook
(`src/studio/photolab/usePhotoLab.ts`) shared with the post editor's Photo lab panel, which keeps
working as it was.

**Assets.** Two tabs, each with its source badge: **Freepik** stock and the **Client's Drive**
photos (the same picker as the editor's Idea group: pin one as the reference). The Freepik tab is
the shared assets panel (see docs/freepik.md, "Assets as design elements"): a search, the chips
Icons · Photos · Backgrounds · Textures · Typography, the results scrolling in their own area, and
a sticky footer with the selected asset's preview and **Add as layer**, **Set as background**,
**Use as reference**, **Save to library**. The footer never scrolls away and never covers the
canvas or the last results; at 640 px and below it becomes a compact action bar clear of the home
indicator. *Add as layer* and *Set as background* download the asset once and open the Text studio
on this post with it already placed (layers live there); the same search and selection are waiting
in its Assets tab. Layers and backgrounds never call an image model: the photo is not made again.

**Versions.** Every take of this post, newest first: the picture, the date, the cost (or *free*),
its note (what it was edited or adjusted for), whether it was made for the idea as it is now or an
earlier one, the team's acceptance on the current picture. **Compare** on a take puts it on the
canvas beside the current picture; pick two takes to compare them with each other. **Use this
picture** restores a take (`POST /api/studio/posts/versions/restore`, as before). *Previous picture*,
the video versions line (when the post has clips) and the month's earlier versions are here too.

**Check.** What the automatic review found (with *Edit this picture* and *Accept as it is*), and
the Writing check (OCR) of the raw picture and the final artwork, the same panel as the editor's.

## Presets and AI tools

### Presets (`server/photo-presets.ts`, `shared/photo-presets.ts`, `src/studio/photo/panels/Presets.tsx`)

The gallery takes the stage (the categories on the left, the cards in a grid, a search box, a
refresh) and the side panel shows the picked entry in full, exactly as the Video studio's gallery
does, with one difference: every card carries the provider's **sample picture** (hotlinked from
the provider, never copied here) and anything whose type says video is dropped. Four categories,
each cached a day per category in an encrypted settings row (`photo_presets_cache_<category>`;
`?refresh=1` asks again), each browse a free `preset.browse` ledger row:

| Category | Ask | What a card is | "Use this …" |
| --- | --- | --- | --- |
| **Styles** | `get_presets {source: "soul", limit: 60}` | a Soul 2.0 picture style: its id is the `style_id` of `generate_image` with `model: "soul_2"`; the preview is a catalog sample | **Use this style**: AI tools → Higgsfield → *Generate with a style*, the style picked and the style's prompt (when it names one) filled in |
| **Product shots** | `get_presets {source: "marketing_studio", category: "product-shot", limit: 60}` | a Marketing Studio preset with picture output; runnable through `execute_preset` on the post's picture | **Use this preset** opens the detail; an admin runs it there (*Run this preset · N credits*, or *cost not known*) |
| **Magnific looks** | `images_upscale_presets_list` and `images_models_list` | an upscale preset or a picture model; a look with no sample keeps its name on a neutral tile that says *No sample from Magnific* | **Use this look**: AI tools → Magnific → *Upscale* with the preset, or *Restyle* with the model |
| **Recipes** | `get_preset_instructions {}` | a picture command (/hero-shot, /reel-cover…), read-only; the video ones (katana, clips) are dropped | **Use these words** when the recipe carries a prompt; *Learn more* shows its instructions |

A pseudo entry never becomes a card: anything without a real id, a title that is not a category
name ("All", "Motion", "Product shot", "Effects"…) and, for the provider catalogs, a sample
picture is filtered (`isRealEntry` in `server/photo-presets.ts`). A product-shot run mirrors the
Video studio's: the detail's price is the estimate, an unknown one is confirmed at an unknown cost,
the post's picture fills the preset's picture input (`media_import_url`, cached an hour), the same
ask within ten minutes is refused, one `preset.run` ledger row in credits, `execute_preset` once;
the job becomes a `photo_tool_jobs` row the AI tools panel shows and the settler collects.

### AI tools (`server/photo-tools.ts`, `shared/photo-tools.ts`, `src/studio/photo/usePhotoTools.ts`, `panels/Tools.tsx`)

Provider tools on the post's picture, in two groups, each tool with its few options:

- **Higgsfield** (the subscription credits, the `higgsfield` switch): Upscale (`upscale_image`),
  Remove background (`remove_background`), Outpaint (`outpaint_image`: a new frame, optional
  words), Reframe (`reframe`: 1:1, 4:5, 9:16), Relight (`relight_image`: the light wanted),
  Generate with a style (`generate_image {params: {model: "soul_2", prompt, medias: [{value: media_id, role: "image"}], style_id?, aspect_ratio?, count: 1}}`).
- **Magnific** (the Magnific balance, the `freepik` switch): Upscale (`images_upscale` with the
  presets and modes from `images_upscale_presets_list` / `images_upscale_modes_list`), Relight,
  Remove background, Replace background (a prompt), Retouch (`retouch_models_list` + a prompt), Skin
  enhancer, Expand, Restyle, Reimagine, Change camera, Variations.

The flow per tool: **Get the cost** (Higgsfield: the same call with `get_cost: true`, sent only
where the live schema lists `get_cost` or for `generate_image`, whose description says so, so an
estimate can never turn into a submission by mistake; Magnific: `simulate_cost {tool, arguments}`)
→ *About N credits · balance M* or *Cost not known* → **Run** → the confirm names the credits →
the same request runs once (`noRetry`, a `claimSubmission` for ten minutes, one `image.tool` ledger
row in credits) → a `photo_tool_jobs` row → the panel polls `GET /jobs` (the server asks
`jobs_wait` / `creations_wait` with a one-second wait, six jobs at most, gives up after half an
hour, never resubmits) → the finished picture is downloaded under the post's output prefix
(`<owner>/<batch>/output/<task>/<job>.<ext>`) and the row closes with the credits the balance moved
by (`balance` / `account_balance` before and after) → before / after on the canvas → **Use as the
post's picture** (the task points at the stored result, a take with the credits in its note, the
previous picture kept as a take and with the month's earlier pictures, *Post N before the AI
tools*), **Save as a product photo** (a `sources` row), **Download**. An unknown Higgsfield cost
may be confirmed anyway (as the Video studio allows); an unknown Magnific cost is blocked (as the
Freepik rules say). Members see the list and *Admins only for now*; `GET /catalog` makes no live
call for a member (the availability shows as unknown), and for an admin reads the live
`tools/list` of each provider, the Magnific option lists (kept an hour in
`photo_tools_magnific_lists`) and the balances, kept an hour (`?refresh=1`).

How our options reach a tool is read from the live schema (`paramFor` in `server/photo-tools.ts`):
a prompt goes under `prompt` / `text` / `description`, a frame under `aspect_ratio` / `aspectRatio`,
a style under `style_id`, and so on; an option the schema does not take is left out and noted in the
ledger row ("the light wanted not taken by relight_image"). The picture goes to Higgsfield as a
media id (`media_id` by default, `medias` for the generator, `params.media_id` when the schema wraps
everything under `params`) and to Magnific as a short-lived signed link where the tool takes a URL
(`imageUrl`, `image_url`, `url`…), else as a creation uploaded first (`creations_upload_image` with
a link when listed, else `creations_request_upload` → PUT → `creations_finalize_upload`, once an
hour per picture). The links in the stored arguments are redacted to `<link>`.

Free vs credits, in one line: Adjust, Versions, Check, browsing the presets and the Drive photos
are free; Edit with AI is the engine's dollar price; the Photo lab is Freepik's API in dollars; the
Presets' runs and the AI tools are credits (Higgsfield's subscription, Magnific's balance), each
figure asked of the provider before the confirm. The videos' billing choice (credits vs Cloud API)
does not apply to pictures: the picture tools always run on the MCP sign-ins.

### What the first live run must check

Every answer shape and argument name above is assumed from the tool descriptions (no provider token
was available while this was built). Check, with the sign-ins made and an admin:

1. **Styles**: the category fills with Soul styles that carry a sample picture (Admin → Integrations
   shows a free `preset.browse` row). If it stays empty while Higgsfield's page shows styles, read
   the stored answer (the tool's text in the browser's network tab, or `get_presets {source: "soul"}`
   from Claude's own Higgsfield MCP) and widen `parseSoulStyles` / `sampleImageOf`: the id
   (`style_id` vs `id`) and the preview field are the likely difference. A card without a sample is
   dropped on purpose; if the live styles carry no preview at all, lift `isRealEntry`'s picture rule
   for the `soul` source.
2. **Product shots**: cards with a still; the video presets must not appear. Learn more shows the
   instructions; *Ready?* says yes once the picture is prefilled (one `media_import_url` in the
   ledger, cached an hour).
3. **Magnific looks**: the models and the upscale presets; which carry a sample, which say *No
   sample from Magnific*; and whether `images_models_list` mixes video models in (the names are
   filtered by words today).
4. **Get the cost** on Upscale (Higgsfield): the balance must not move (if it does, `upscale_image`
   ran on `get_cost: true` instead of pricing: remove `get_cost` from `costable` for that tool and
   let it be "cost not known"). Reframe is "cost not known" by design (its schema wraps `params`).
5. **One Higgsfield run** (Upscale or Remove background): the job id lands, the picture arrives
   within a few polls, the `image.tool` row reads "N credits reported (balance a → b)"; if the
   result link is missing, `show_generation_by_ids` is tried; check the picture's content type
   (the download keeps what the provider sends; an unknown one is stored as PNG).
6. **Generate with a style**: the `generate_image` params as the ask shaped them (`model: "soul_2"`,
   `style_id`, `medias`); whether the answer is a job list (`jobs[].job_id`) or a single job.
7. **Magnific**: `simulate_cost` gives a figure for `images_upscale` with the picture as a link; the
   ledger notes "picture: link as imageUrl" or "creation as creationIdentifier" (the job's
   `settings.notes` keeps it). One cheap tool: the creation identifier lands, `creations_wait`
   finishes it, the picture is a JPEG or PNG under the post. Check `account_balance` reads a number.
8. **Use as the post's picture**: the take appears under Versions with the credits in its note, the
   previous picture under the month's earlier pictures.

### What the live run found (23 Oct 2026, production, a temporary admin, deleted after)

- **Styles** (33) and **Product shots** (100) fill with sample pictures. **Magnific looks** (51)
  showed no sample until `images_models_list` was asked with `includePreviews: true`; the sample
  sits under `previewImageUrl` (49 of 51 carry one). **Recipes** (34) are commands with no
  picture by nature. Magnific's catalogs answer a compact YAML-like text, not JSON (`parseYamlish`
  in `server/mcp-client.ts` reads it).
- **The live tool shapes**: the Higgsfield picture tools nest their arguments under `params` with
  their own names, read from each tool's schema by `HiggsfieldMcp.toolShape`: `upscale_image`
  `{image_id, width, height, resolution, get_cost}` (the source size is required: read from the
  stored file's header), `remove_background` `{media_id, media_type}`, `outpaint_image`
  `{image_id, aspect_ratio, get_cost}`, `generate_image` `{model, prompt, medias, …}`. `reframe` is
  a video tool and left the picture catalog (Outpaint takes a new frame). `relight_image` is not
  listed on this plan.
- **Get the cost** on Upscale: 2 credits, the balance unchanged. **One run**: the job id comes in
  prose ("Submitted 1 job. … \n- <uuid>"), not a JSON `jobs` list; `parseJobs` reads it. The
  first live run was charged 2 credits (balance 5606.75 → 5604.75) before that was read right, so
  its result stayed at Higgsfield (job `30eade26…`) and the studio's row says failed.
- **Cost not known**: Higgsfield's picture tools other than Upscale and Outpaint take no
  `get_cost`; the credits the last finished run of the same tool reported stand as the estimate
  ("estimate from the last run of …" in the notes) until the provider prices them.
- **Assets** (Freepik stock) showed blank cards: the previews link over plain `http://img.b2bpic.net`,
  refused on the https page; every preview is now handed out over https.

## The canvas

The picture large; zoom to fit, 100% or in between (the pill at the bottom right, **Z** to toggle
fit / 100%, ⌘ or Ctrl + wheel over the picture); the stage scrolls to pan, or drag the picture when
it is larger than the stage. The compare slider, the marked area and the crop frame sit on it.

Keyboard: `[` `]` previous / next post · `Z` zoom fit / 100% · `C` hold to see the original (or, in
Adjust, the picture before the adjustments) · `Esc` closes the active tool (stop marking, stop the
compare, take the crop frame off), then the studio · ⌘Z / ⇧⌘Z undo / redo the adjustments.

## Members and admins

Everything free works for every member of the month: Edit with AI follows the month's existing
permission (the task's `revise`), Adjust, Versions, Check and browsing the Presets. The Photo lab
and the Freepik tab of Assets read `access` from `/api/studio/photolab/status` and `admin` from
`/api/studio/freepik/status`; the AI tools read `admin` and each provider's `enabled` from
`/api/studio/photo/tools/catalog`: a member sees **Admins only for now** with no provider controls,
and the rail marks those three tools with a small lock. The rules are in `docs/integrations.md`.

## The Adjust pipeline and its limits

`shared/photo-adjust.ts` holds the pure part: the parameters, the crop maths (the largest centred
crop of an aspect, clamping, a handle dragged with the far side anchored, whole-pixel rounding), the
tone curve (exposure as a gain in stops, contrast around middle grey, highlights and shadows
weighted by tone), saturation around the pixel's luma, white balance gains, the unsharp mask and
the vignette, each as a function on an RGBA buffer. `tests/photo-adjust.test.ts` checks them on
numbers and small buffers. `src/studio/photo/render.ts` does the geometry with a canvas (quarter
turns, flips, straightening with the fill scale, the crop) and hands the pixels to the pure
pipeline.

- The preview is drawn at most 1200 px on its long side, on every parameter change (a frame per
  animation tick); sharpen and vignette on the preview approximate the full picture.
- Apply draws at full resolution, capped at **4096 px** on the long side (4096² RGBA is 64 MB of
  pixels in the browser; the engines make at most about 2K). The file goes up as PNG when the
  source was a PNG, JPEG (quality 0.94) otherwise, at most **20 MB**.
- Nothing is sent anywhere until Apply; the preview never leaves the browser.

## The upload route

`POST /api/studio/posts/picture/upload` (multipart: `batch`, `index`, `file` PNG / JPEG / WebP ≤
20 MB, optional `note`), next to the takes and restore routes in `server/posts.ts`:

- The month's permission is the restore route's (`ownedPlan`: the owner's month, or any month for
  an admin); another member's month answers 404 as the restore does.
- The file is decoded once through `storeBytes` (an unreadable file is refused with 415, a wrong
  type with 415, a file over 20 MB with 413) and a 360 px thumbnail is kept; the picture itself is
  stored under the month (`<owner>/<batch>/output/<task>/<id>.<ext>`), where every picture of the
  month lives, so Versions, Compare and the overlay keep working.
- A take row is recorded (cost 0, the note given or *Adjusted in the Photo studio*, `made_for` the
  post's revision as it is now), the task's picture is replaced exactly as `/versions/restore`
  replaces one (status ready, the review cleared), and the previous picture is kept with the
  month's earlier pictures (*Post N before the Photo studio*) as well as staying a take.
- A post without a picture slot, or one being made, answers 409. No network call is ever made.

`tests/photo-upload.test.ts` covers the permission, the stored file and thumbnail, the take row,
the task's picture, the snapshot, the note, 415 / 413 / 400 / 409, and asserts zero network calls
(the paid-route guard).

## Verified

- Unit: `tests/photo-adjust.test.ts` (19 tests) and `tests/photo-upload.test.ts` (5 tests), with the
  rest of the suite.
- `tests/editor-continuity.test.ts` (7 tests, under the paid-route guard): who holds a version; a
  picture save on an approved post (and on a shared one) keeps the post's picture, the answer and
  the share link exactly as before, stores the new take, then **Send it for review** swaps it in,
  clears the answer and keeps the old picture; a picture that is not a take is refused; the
  session store carries, persists and clears each part.
- Browser (`scripts/editor-continuity-smoke.mjs`, 1440 and 390 px): Photo studio adjust → Text
  studio (nothing uploaded; a layer added and saved) → Video studio → Photo studio (exposure still
  +60) → **Save & return** (one upload, the card in view, highlighted, showing the new picture);
  reopening shows the saved state; an approved card keeps its picture and offers **Send it for
  review**; **Save & return** stays on screen in the Photo and Text studios at 390 px.
- `tests/photo-presets.test.ts` (11 tests, under the paid-route guard): Soul styles, product shots,
  Magnific looks and recipes normalised (pseudo entries, video entries and entries without a sample
  dropped); Not signed in with no call; a member browsing the styles, the encrypted cache row, the
  day's cache from the isolate and from the row, `?refresh=1`, the asks of every category, the free
  `preset.browse` rows; the Magnific looks with and without samples and the switch off; the detail
  of a product shot for a member and an admin (the readiness with the picture prefilled), a style
  from the cache, a recipe; a run refused to a member, for a recipe, for a style, with the switch
  off; the confirm with the detail's price → `execute_preset` with the picture in the input →
  `jobs_wait` → the PNG under the post's output prefix served to a member → the `preset.run` row
  with the credits the balance moved by; a preset with no price blocked until confirmed.
- `tests/photo-tools.test.ts` (10 tests, under the paid-route guard): the option-to-argument
  mapping (`paramFor`, `higgsfieldArgs`, `magnificOptionArgs`, the Magnific list shapes); the
  catalog for a member (no call) and an admin (availability, lists, balances, the hour's cache and
  the refresh); a member and the switch refused; Upscale: `get_cost` → `image.estimate` → 409
  needsConfirm → the run once → the picture imported once → `jobs_wait` → the picture → the ledger
  "12 credits reported (balance 1500 → 1488)" → Use as the post's picture (the task, the take with
  the credits in its note, the snapshot of the previous picture) and Save as a product photo (the
  `sources` row); Reframe "cost not known" until confirmed, a synchronous answer finished at once,
  Generate with a style's params; Magnific: not connected, the switch off, `simulate_cost` with the
  picture as a link → confirm → `images_upscale` → `creations_wait` → a JPEG; Relight with the
  picture uploaded as a creation (request → PUT → finalize); an unknown Magnific cost blocked.
  Every test asserts zero network calls outside the stubs.
- Browser (`scripts/photo-studio-smoke.mjs`, headless Chromium against the built app and a boot
  mock, no Worker, no provider): the month opens, the card's **Edit picture** opens the studio on
  the Edit panel, the rail shows the six tools, the Adjust canvas brightens a pixel with exposure
  +60 (120 → 182 red), undo lights up, the crop frame shows its eight handles, Apply confirms and
  posts one multipart form to the upload route and clears the *Adjustments not applied* chip,
  Versions lists the take, Check shows the review, the Photo lab shows four cards with the note
  about Magnific's tools, the Presets panel lists the four categories and draws the fixture cards
  with their sample `<img>` (loaded from the test server) and the *No sample from Magnific* tile,
  "Use this style" opens AI tools with the style picked and its words in the prompt, the AI tools
  panel lists both providers (six Higgsfield tools, eleven Magnific tools, the upscale presets from
  the catalog) with the "Get the cost" button, and at 390 px the rail gives way to a bottom toolbar
  of seven tools (Presets and AI tools under one "AI" button) with no sideways scroll and no
  overflow of the toolbar itself, with the gallery and the tools panel both opened on the phone. No
  page errors, no request outside the test server. Screenshots at 1440 (Edit, Adjust, Presets, AI
  tools) and 390 (Edit, AI tools, Presets) were inspected.
- Not verified in a browser: a real AI edit, a real Photo lab run and a real Freepik search (fakes
  and demo only; no paid call was made), dictation (needs a microphone), the Drive picker on a
  client with Drive photos, the Text studio ↔ Photo studio switch on a saved month (typed and
  built, not clicked), and anything the Presets and AI tools do against the live MCP servers (see
  "What the first live run must check": the shapes are stubs, no provider token was available).
