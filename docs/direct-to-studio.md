# Start: four options, two of them direct to the Studio

The Start screen of the four-stage workflow (`src/studio/Flow.tsx`) offers exactly four cards, one
design each (a picture, a title, one line, the same buttons):

| Card                     | Buttons                           | What happens                                                        |
| ------------------------ | --------------------------------- | ------------------------------------------------------------------- |
| **Quick Campaign**       | Write a brief                     | As before: the brief, then Direction, Plan, Studio.                 |
| **Follow a grid**        | Pick a grid                       | As before: the grid, then Direction, Plan, Studio.                  |
| **Edit images**          | Choose from Drive · Upload files  | Direct to Studio: one card per picture.                             |
| **Create or edit video** | Choose from Drive · Upload files  | Direct to Studio: one card per picture or clip, then combine.       |

"Use theme references" and "One post from a style" are no longer Start cards. Nothing was taken
away: the theme's references are in Direction (Theme references · Add / Manage / Analyse the pins),
styles are on the Studio cards (Pick a style, and Apply a style to chosen cards) and in the style
gallery; a month can still be led by its theme references.

The video card shows the client's newest finished clip through the shared `AutoplayVideo`
(`mode="preview"`, `GET /api/studio/media/clip`), else a still.

## The selection dialog (`src/studio/MediaIntake.tsx`)

- **Client's Drive**: the client's approved folders (the existing listing and thumbnails), by role
  and searchable, multi-select. Edit images lists clips but they cannot be picked; on the video
  route clips are picked by admins only (members see why).
- **This computer**: drop or Upload files. "Upload files" on a card opens the file chooser at once.
- One **tray** holds everything picked from both sources, numbered in the order picked, each
  removable. Nothing is downloaded and uploaded again by hand.
- The client and month are the workspace's. Only when one is missing does the dialog ask for the
  client and the month, nothing else.
- Confirming copies the files into the month and opens the Studio on the new cards, which arrive
  **chosen** (ready for the next explicit step; nothing runs by itself). No brief, theme, shot or
  product is asked for, and nothing is generated.

## `POST /api/studio/media/intake` (`server/media-intake.ts`)

Multipart: `kind` (`images` | `video`), `batch` (or `client` + `month`), `items` (JSON:
`{from:"drive", id}` or `{from:"upload", field:"file<n>", poster?:"poster<n>"}`), the files.

- Every gate is checked before anything is written: the month's permission (a member's own month,
  an admin's any month), the Drive file must be in the client's folders, pictures PNG/JPEG/WebP up
  to 20 MB (read from their bytes), clips MP4 H.264 up to 60 MB, 24 files and 95 MB per request
  (the browser sends larger picks in groups), at most 60 posts in a month.
- Pictures: every member (a free copy). Clips: admins only, like `POST /posts/video/upload`.
- Drive is only **read** (`driveFileCopy`: the drive.readonly scope, GET only). A JPEG/PNG/WebP is
  copied byte for byte; HEIC, TIFF or a huge file comes as Drive's large rendition. The original is
  never changed.
- Each new file becomes one post appended after the month's posts (never over one): `source:
  "media"`, `media: {kind, from, name, fp, drive?, at}`, type lifestyle, the file's name as its
  title, an empty brief. Its task is `ready` with the copy as its picture (`made_for` = the post's
  revision) and a free take ("Copied from the client's Drive: …" / "Uploaded: …"). A clip is also a
  finished `videos` row (provider `upload`, the client's version when the post has none); the card's
  picture is the frame the browser read, Drive's frame, else a dark still.
- **Idempotent**: the fingerprint (`drive:<id>:<md5|version>` or `upload:<sha256>`) finds the card
  already made; the same pick twice makes no second card (answered under `existing`).
- Media posts are left alone by the Plan and Direction checks (`shared/issues.ts`), are never an
  "older idea", and Generate never makes them (`preparePlan` skips them).
- No migration: everything lives in the month's config and the existing tables.

## Choosing cards in the Studio (`src/studio/MediaSelection.tsx`)

**Choose cards** (or the cards just added) shows a tick on each card and a bar with scoped steps:

- **Apply a style to N chosen**: the style gallery, then one confirm naming the posts. The style is
  saved on those cards only; nothing is made. A media card then shows **Restyle · about $X**: the
  Photo studio's AI edit (`POST /api/studio/revise`) for that one picture, confirmed with its cost.
  Planned (non-media) cards get their idea written in the style; making their pictures stays its own
  step. Nothing is ever batch-spent.
- **Open in Text studio**: the chosen cards one by one (closing one opens the next).
- **Combine into one video** (admins, the Video editor's rule): the chosen cards in order
  (reorderable), saved on a new card or one of them. `POST /api/studio/media/combine` copies each
  card's clip as a version of the target card (a picture card joins as a 3-second H.264 clip drawn
  in the browser, `src/studio/stillClip.ts`), writes one `video_projects` row with exactly those
  clips in that order and a ledger line `editor.save` (estimate 0), and the Video editor opens on
  the target card with that project. Uploading pictures never starts image-to-video generation;
  Generate stays an explicit, confirmed step in the editor.

## Tests

- `tests/media-intake.test.ts`: Drive-only, upload-only and mixed picks; one and several pictures;
  the same pick twice; refused types, sizes and foreign Drive ids; a member's clip refused; clips and
  pictures on the video route with no generation; the month made when missing; the issues and
  Generate leaving media cards alone; combine order, target and admin gate. The paid guard proves no
  network call (no Drive write, no engine).
- `scripts/start-direct-smoke.mjs` (after `npm run build`): the four cards (one size, the same
  buttons), Drive + computer in one tray, landing on the Studio cards, two clips combined into one
  project in the Video editor, at 1440 and 390 px. Screenshots in `test-results/start-direct`.
