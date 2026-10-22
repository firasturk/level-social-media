# Photo studio

One full-screen workspace for a post's picture, with the same shell as the Text studio: a top bar,
a rail of tools on the left, the picture large in the middle, the chosen tool's panel on the
right. On a phone (≤ 860 px, the Text studio's own breakpoint) one panel shows at a time, picked
from a bottom toolbar of the same six icons, and the top bar's buttons keep their icons only.

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
  first). The Photo studio's top bar has **Text studio** back.

## The top bar

The post number and title, the picture's state (Ready, Review, Making…, Failed), undo / redo (over
the Adjust parameters), **Versions · n** (the count of takes; opens the Versions panel),
**Text studio**, **Close**. Closing with adjustments not yet applied asks: *Apply and close* or
*Leave without applying*.

## The six panels

| Panel | Icon | Costs | Who |
| --- | --- | --- | --- |
| **Edit** (AI) | wand | one paid picture per edit (the engine's price, said before the confirm) | whoever opened the month |
| **Adjust** | sliders | free: drawn in the browser, nothing is generated | everyone |
| **Photo lab** | flask | Freepik, about the price shown per tool; a demo when no key is saved | admins only for now |
| **Assets** | pictures | Freepik stock: a download is proposed with its estimate; the client's Drive is free | Freepik: admins only for now; Drive: everyone |
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
upscale) with what each is good for and about what it costs; the picture source (this post's
picture, the client's Drive photos, or an earlier result through *Run another tool on this
result*); a prompt with dictation for the two tools that take one; **Run** proposes the job (the
server writes the estimate to the ledger first), the confirm shows the estimate, and the same
request runs. The result goes on the canvas as before / after; then **Use as the post's picture**,
**Save as a product photo**, **Download**. Earlier results are listed. The logic is one hook
(`src/studio/photolab/usePhotoLab.ts`) shared with the post editor's Photo lab panel, which keeps
working as it was.

**Assets.** Two tabs: Freepik stock (the search and the library, in reference mode: *Use as
reference* makes the asset the post's reference for its next AI edit) and the client's Drive photos
(the same picker as the editor's Idea group: pin one as the reference). *Add to design* (a picture
layer over the post) is made in the Text studio, where layers live: the panel says so and offers
the switch.

**Versions.** Every take of this post, newest first: the picture, the date, the cost (or *free*),
its note (what it was edited or adjusted for), whether it was made for the idea as it is now or an
earlier one, the team's acceptance on the current picture. **Compare** on a take puts it on the
canvas beside the current picture; pick two takes to compare them with each other. **Use this
picture** restores a take (`POST /api/studio/posts/versions/restore`, as before). *Previous picture*,
the video versions line (when the post has clips) and the month's earlier versions are here too.

**Check.** What the automatic review found (with *Edit this picture* and *Accept as it is*), and
the Writing check (OCR) of the raw picture and the final artwork, the same panel as the editor's.

## The canvas

The picture large; zoom to fit, 100% or in between (the pill at the bottom right, **Z** to toggle
fit / 100%, ⌘ or Ctrl + wheel over the picture); the stage scrolls to pan, or drag the picture when
it is larger than the stage. The compare slider, the marked area and the crop frame sit on it.

Keyboard: `[` `]` previous / next post · `Z` zoom fit / 100% · `C` hold to see the original (or, in
Adjust, the picture before the adjustments) · `Esc` closes the active tool (stop marking, stop the
compare, take the crop frame off), then the studio · ⌘Z / ⇧⌘Z undo / redo the adjustments.

## Members and admins

Everything free works for every member of the month: Edit with AI follows the month's existing
permission (the task's `revise`), Adjust, Versions and Check. The Photo lab and the Freepik tab of
Assets read `access` from `/api/studio/photolab/status` and `admin` from
`/api/studio/freepik/status`: a member sees **Admins only for now** with no provider controls, and
the rail marks those two tools with a small lock. The rules are in `docs/integrations.md`.

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
- Browser (`scripts/photo-studio-smoke.mjs`, headless Chromium against the built app and a boot
  mock, no Worker, no provider): the month opens, the card's **Edit picture** opens the studio on
  the Edit panel, the rail shows the six tools, the Adjust canvas brightens a pixel with exposure
  +60 (120 → 182 red), undo lights up, the crop frame shows its eight handles, Apply confirms and
  posts one multipart form to the upload route and clears the *Adjustments not applied* chip,
  Versions lists the take, Check shows the review, the Photo lab shows four cards, and at 390 px
  the rail gives way to a bottom toolbar of six tools with no sideways scroll. No page errors, no
  request outside the test server. Screenshots at 1440 (Edit and Adjust) and 390 were inspected.
- Not verified in a browser: a real AI edit, a real Photo lab run and a real Freepik search (fakes
  and demo only; no paid call was made), dictation (needs a microphone), the Drive picker on a
  client with Drive photos, and the Text studio ↔ Photo studio switch on a saved month (typed and
  built, not clicked).
